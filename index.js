/**
 * Cloudflare Worker: Universal Social Media Media Downloader API  (v2)
 * Runtime: ES Modules, zero dependencies.
 *
 * Routes
 *   GET  /?url=<post link>        -> JSON { success, platform, title, thumbnail, media:[{url,quality,type}] }
 *   POST /  {"url": "<link>"}     -> same
 *   GET  /?proxy=<media url>      -> streams the media (Range supported) with CORS, so <video> and downloads work
 *                                    add &dl=1 to force "Content-Disposition: attachment"
 *
 * media[] is always sorted: video first, then image, then audio. type is "video" | "image" | "audio".
 * Optional secrets: IG_COOKIE, FB_COOKIE, X_BEARER_TOKEN, X_GRAPHQL_ID
 */

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36"
];

const TWITTER_BEARER_TOKEN = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const DEFAULT_X_GRAPHQL_ID = "0hWvDhmW8YQ-S_ib3azIrw";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Range",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Type",
  "Content-Type": "application/json; charset=utf-8"
};

// Hosts the /?proxy= endpoint may fetch (prevents the Worker being used as an open proxy)
const PROXY_HOSTS = [
  /(^|\.)cdninstagram\.com$/, /(^|\.)fbcdn\.net$/, /(^|\.)fbsbx\.com$/, /(^|\.)twimg\.com$/,
  /(^|\.)redd\.it$/, /(^|\.)redditmedia\.com$/, /(^|\.)redditstatic\.com$/, /(^|\.)pinimg\.com$/
];

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      const reqUrl = new URL(request.url);

      // Media streaming proxy
      if (request.method === "GET" && reqUrl.searchParams.get("proxy")) {
        return await handleProxy(request, reqUrl);
      }

      // 1. Read the post URL from GET query or POST JSON body
      let targetUrl = null;
      if (request.method === "GET") {
        targetUrl = reqUrl.searchParams.get("url");
      } else if (request.method === "POST") {
        const contentType = request.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const body = await request.json().catch(() => ({}));
          targetUrl = body.url;
        }
      } else {
        return jsonResponse({ success: false, error: "Method not allowed. Use GET or POST." }, 405);
      }

      if (!targetUrl || typeof targetUrl !== "string") {
        return jsonResponse({
          success: false,
          error: "Missing 'url' parameter. Provide ?url=... via GET or {\"url\": \"...\"} via POST."
        }, 400);
      }

      let parsedUrl;
      try { parsedUrl = new URL(targetUrl.trim()); }
      catch { return jsonResponse({ success: false, error: "Invalid URL format provided." }, 400); }

      const ssrfCheck = validateSafeUrl(parsedUrl);
      if (!ssrfCheck.valid) return jsonResponse({ success: false, error: ssrfCheck.reason }, 400);

      if (isYouTubeUrl(parsedUrl.hostname)) {
        return jsonResponse({ success: false, error: "YouTube downloads are not supported" }, 400);
      }

      // 2. Resolve short links with SSRF validation on every hop
      const resolvedUrl = new URL(await resolveRedirects(parsedUrl.toString()));
      const postCheck = validateSafeUrl(resolvedUrl);
      if (!postCheck.valid) return jsonResponse({ success: false, error: postCheck.reason }, 400);
      if (isYouTubeUrl(resolvedUrl.hostname)) {
        return jsonResponse({ success: false, error: "YouTube downloads are not supported" }, 400);
      }

      // 3. Route by platform
      const platform = detectPlatform(resolvedUrl.hostname);
      if (!platform) {
        return jsonResponse({
          success: false,
          error: `Unsupported platform (${resolvedUrl.hostname}). Supported: Instagram, X/Twitter, Pinterest, Reddit, Facebook.`
        }, 400);
      }

      let result;
      switch (platform) {
        case "x":         result = await extractX(resolvedUrl, env); break;
        case "reddit":    result = await extractReddit(resolvedUrl); break;
        case "instagram": result = await extractInstagram(resolvedUrl, env); break;
        case "pinterest": result = await extractPinterest(resolvedUrl); break;
        case "facebook":  result = await extractFacebook(resolvedUrl, env); break;
      }

      if (!result || !result.media || result.media.length === 0) {
        return jsonResponse({
          success: false,
          error: `Could not extract downloadable media from ${platform}. Ensure the post is public and contains video or image media.`
        }, 404);
      }

      return jsonResponse({
        success: true,
        platform,
        title: result.title || `${platform.toUpperCase()} Media`,
        thumbnail: result.thumbnail || null,
        media: sortMedia(result.media)
      }, 200);

    } catch (err) {
      return jsonResponse({ success: false, error: err.message || "Internal Worker extraction error." }, 500);
    }
  }
};

/* ============================================================================
 * MEDIA STREAMING PROXY
 * ========================================================================== */

async function handleProxy(request, reqUrl) {
  let target;
  try { target = new URL(reqUrl.searchParams.get("proxy")); }
  catch { return jsonResponse({ success: false, error: "Invalid proxy URL." }, 400); }

  const safe = validateSafeUrl(target);
  if (!safe.valid) return jsonResponse({ success: false, error: safe.reason }, 400);
  if (!PROXY_HOSTS.some(re => re.test(target.hostname.toLowerCase()))) {
    return jsonResponse({ success: false, error: "This media host is not allowed through the proxy." }, 403);
  }

  const upstreamHeaders = { "User-Agent": USER_AGENTS[0], "Accept": "*/*" };
  const range = request.headers.get("range");
  if (range) upstreamHeaders["Range"] = range;
  if (/redd\.it$|reddit/.test(target.hostname)) upstreamHeaders["Referer"] = "https://www.reddit.com/";

  const upstream = await fetch(target.toString(), { headers: upstreamHeaders, redirect: "follow" });

  const headers = new Headers();
  for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (!headers.has("accept-ranges")) headers.set("accept-ranges", "bytes");
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, Content-Type");
  headers.set("Cache-Control", "public, max-age=3600");

  if (reqUrl.searchParams.get("dl")) {
    const ct = upstream.headers.get("content-type") || "";
    const ext = ct.includes("video") ? "mp4" : ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : ct.includes("audio") ? "m4a" : "jpg";
    headers.set("Content-Disposition", `attachment; filename="media-${Date.now()}.${ext}"`);
  }

  return new Response(upstream.body, { status: upstream.status, headers });
}

function sortMedia(list) {
  const rank = { video: 0, image: 1, audio: 2 };
  return list
    .map((m, i) => ({ m, i }))
    .sort((a, b) => (rank[a.m.type] ?? 3) - (rank[b.m.type] ?? 3) || a.i - b.i)
    .map(x => x.m);
}

/* ============================================================================
 * SSRF VALIDATION & SAFE REDIRECT RESOLUTION
 * ========================================================================== */

function validateSafeUrl(urlObj) {
  if (urlObj.protocol !== "http:" && urlObj.protocol !== "https:") {
    return { valid: false, reason: "Invalid URL protocol. Only HTTP and HTTPS are allowed." };
  }
  const hostname = urlObj.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    return { valid: false, reason: "Access to local or internal hostnames is forbidden." };
  }

  if (hostname.includes(":")) {
    if (
      hostname === "::1" || hostname === "::" || hostname === "0:0:0:0:0:0:0:1" || hostname === "0:0:0:0:0:0:0:0" ||
      hostname.startsWith("fe80:") || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("::ffff:")
    ) {
      return { valid: false, reason: "Access to private or loopback IPv6 addresses is forbidden." };
    }
  }

  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1, 5).map(Number);
    if (octets.some(o => o > 255)) return { valid: false, reason: "Invalid IPv4 address." };
    const [a, b] = octets;
    if (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    ) {
      return { valid: false, reason: "Access to private, loopback, or reserved IPv4 ranges is forbidden." };
    }
  }
  return { valid: true };
}

async function resolveRedirects(initialUrl, maxRedirects = 5) {
  let currentUrl = initialUrl;
  for (let i = 0; i < maxRedirects; i++) {
    let parsedCurrent;
    try { parsedCurrent = new URL(currentUrl); }
    catch { throw new Error("Malformed URL encountered during redirect resolution."); }

    const check = validateSafeUrl(parsedCurrent);
    if (!check.valid) throw new Error(check.reason);

    let res;
    try {
      res = await fetch(currentUrl, { method: "HEAD", redirect: "manual", headers: getSpoofedHeaders() });
      if (res.status === 405 || res.status === 403) {
        res = await fetch(currentUrl, { method: "GET", redirect: "manual", headers: getSpoofedHeaders() });
      }
    } catch { break; }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) break;
      const nextUrl = new URL(location, currentUrl);
      const nextCheck = validateSafeUrl(nextUrl);
      if (!nextCheck.valid) throw new Error(`Redirect blocked: ${nextCheck.reason}`);
      currentUrl = nextUrl.toString();
    } else {
      break;
    }
  }
  return currentUrl;
}

/* ============================================================================
 * PLATFORM EXTRACTORS
 * ========================================================================== */

async function extractX(urlObj, env) {
  const match = urlObj.pathname.match(/\/(?:status|statuses)\/(\d+)/);
  if (!match) throw new Error("Could not find a valid Tweet/X status ID in the URL.");
  const tweetId = match[1];

  // Method 1: Syndication endpoint
  try {
    const token = computeSyndicationToken(tweetId);
    const res = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en&token=${token}`, {
      headers: getSpoofedHeaders({ Referer: "https://platform.twitter.com/" })
    });
    if (res.ok) {
      const parsed = parseSyndicationData(await res.json());
      if (parsed && parsed.media.length > 0) return parsed;
    }
  } catch (_) { /* fall through */ }

  // Method 2: Guest token + GraphQL
  const bearer = env.X_BEARER_TOKEN || TWITTER_BEARER_TOKEN;
  const graphqlQueryId = (env.X_GRAPHQL_ID && env.X_GRAPHQL_ID.trim()) || DEFAULT_X_GRAPHQL_ID;

  const guestRes = await fetch("https://api.x.com/1.1/guest/activate.json", {
    method: "POST",
    headers: { "Authorization": `Bearer ${bearer}`, "User-Agent": getRandomUA() }
  });
  if (!guestRes.ok) throw new Error("Failed to acquire X Guest Token and Syndication fallback returned no media.");
  const { guest_token } = await guestRes.json();

  const features = {
    creator_subscriptions_tweet_preview_api_enabled: true,
    tweetypie_unmention_optimization_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    longform_notetweets_rich_text_read_enabled: true,
    responsive_web_enhance_cards_enabled: false
  };
  const variables = { tweetId, withCommunity: false, includePromotedContent: false, withVoice: false };

  const graphqlUrl = `https://api.x.com/graphql/${encodeURIComponent(graphqlQueryId)}/TweetResultByRestId?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent(JSON.stringify(features))}`;
  const gqlRes = await fetch(graphqlUrl, {
    headers: { "Authorization": `Bearer ${bearer}`, "x-guest-token": guest_token, "User-Agent": getRandomUA(), "Accept": "application/json" }
  });

  if (!gqlRes.ok) {
    if (gqlRes.status === 400 || gqlRes.status === 404) {
      throw new Error(`X GraphQL endpoint returned HTTP ${gqlRes.status}. The GraphQL Query ID (${graphqlQueryId}) may have rotated—update X_GRAPHQL_ID in Worker Secrets.`);
    }
    throw new Error(`X GraphQL request failed with status ${gqlRes.status}`);
  }

  const gqlData = await gqlRes.json().catch(() => null);
  if (!gqlData || (gqlData.errors && !gqlData.data)) {
    throw new Error(`X GraphQL query error: ${gqlData?.errors?.[0]?.message || "Invalid GraphQL response structure."}. Consider updating X_GRAPHQL_ID.`);
  }

  const legacy = gqlData?.data?.tweetResult?.result?.legacy || gqlData?.data?.tweetResult?.result?.tweet?.legacy;
  if (!legacy) throw new Error("Tweet data unavailable, age-restricted, or protected.");

  const title = cleanText(legacy.full_text || "X Video");
  let thumbnail = null;
  const mediaList = [];

  for (const item of legacy.extended_entities?.media || legacy.entities?.media || []) {
    if (!thumbnail && item.media_url_https) thumbnail = item.media_url_https;
    if (item.type === "video" || item.type === "animated_gif") {
      const variants = (item.video_info?.variants || [])
        .filter(v => v.content_type === "video/mp4")
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      if (variants.length > 0) {
        mediaList.push({ url: variants[0].url, quality: (variants[0].bitrate || 0) >= 2000000 ? "HD" : "SD", type: "video" });
      }
    } else if (item.type === "photo" && item.media_url_https) {
      mediaList.push({ url: `${item.media_url_https}?name=orig`, quality: "HD", type: "image" });
    }
  }
  return { title, thumbnail, media: mediaList };
}

async function extractReddit(urlObj) {
  const cleanPath = urlObj.pathname.replace(/\/+$/, "");
  const res = await fetch(`https://www.reddit.com${cleanPath}.json?raw_json=1`, {
    headers: getSpoofedHeaders({ Accept: "application/json", Referer: "https://www.reddit.com/" })
  });
  if (!res.ok) throw new Error(`Reddit API returned HTTP ${res.status}`);

  const data = await res.json();
  const post = Array.isArray(data) ? data[0]?.data?.children?.[0]?.data : data?.data?.children?.[0]?.data;
  if (!post) throw new Error("Unable to parse Reddit post data.");

  const targetPost = (post.crosspost_parent_list && post.crosspost_parent_list[0]) || post;
  const title = targetPost.title || "Reddit Media";
  let thumbnail = targetPost.preview?.images?.[0]?.source?.url || targetPost.thumbnail || null;
  if (thumbnail && !thumbnail.startsWith("http")) thumbnail = null;
  if (thumbnail) thumbnail = decodeHtmlEntities(thumbnail);

  const media = [];

  const redditVideo = targetPost.secure_media?.reddit_video || targetPost.media?.reddit_video || targetPost.preview?.reddit_video_preview;
  if (redditVideo && redditVideo.fallback_url) {
    const cleanVideoUrl = redditVideo.fallback_url.split("?")[0];
    media.push({ url: cleanVideoUrl, quality: redditVideo.height >= 720 ? "HD" : "SD", type: "video" });

    if (!redditVideo.is_gif) {
      const basePath = cleanVideoUrl.substring(0, cleanVideoUrl.lastIndexOf("/"));
      if (basePath.startsWith("http")) {
        for (const candidateUrl of [`${basePath}/DASH_AUDIO_128.mp4`, `${basePath}/DASH_AUDIO_64.mp4`, `${basePath}/DASH_audio.mp4`, `${basePath}/audio`]) {
          try {
            const audioHead = await fetch(candidateUrl, { method: "HEAD", headers: getSpoofedHeaders({ Referer: "https://www.reddit.com/" }) });
            if (audioHead.ok && audioHead.status === 200) {
              media.push({ url: candidateUrl, quality: "Audio", type: "audio" });
              break;
            }
          } catch (_) { /* try next */ }
        }
      }
    }
  }

  if (targetPost.is_gallery && targetPost.media_metadata) {
    for (const key of Object.keys(targetPost.media_metadata)) {
      const item = targetPost.media_metadata[key];
      if (item.status === "valid" && item.s) {
        const mediaUrl = item.s.mp4 || item.s.u || item.s.gif;
        if (mediaUrl) {
          media.push({
            url: decodeHtmlEntities(mediaUrl),
            quality: "HD",
            type: item.e === "AnimatedImage" && item.s.mp4 ? "video" : "image"
          });
        }
      }
    }
  }

  if (media.length === 0) {
    const mp4Variant = targetPost.preview?.images?.[0]?.variants?.mp4?.source?.url;
    if (mp4Variant) {
      media.push({ url: decodeHtmlEntities(mp4Variant), quality: "HD", type: "video" });
    } else if (targetPost.url_overridden_by_dest && /\.(jpg|jpeg|png|webp|gif|mp4)$/i.test(targetPost.url_overridden_by_dest)) {
      media.push({
        url: targetPost.url_overridden_by_dest,
        quality: "HD",
        type: /\.mp4$/i.test(targetPost.url_overridden_by_dest) ? "video" : "image"
      });
    }
  }
  return { title, thumbnail, media };
}

/**
 * Instagram Extractor (fixed)
 * - Video links are searched in BOTH plain and backslash-escaped JSON (the embed page escapes its quotes).
 * - A video's cover frame is never returned as media; it only becomes `thumbnail`.
 * - If the post is a video and no video file was found, the next strategy is tried; at the end an error is thrown
 *   instead of returning just a thumbnail.
 */
async function extractInstagram(urlObj, env) {
  const match = urlObj.pathname.match(/\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  if (!match) throw new Error("Invalid Instagram URL. Provide a link to a Reel, Post, or Video (/p/, /reel/, or /tv/).");
  const shortcode = match[2];
  const expectVideo = match[1] !== "p";   // reels & IGTV are always videos

  const baseHeaders = getSpoofedHeaders({
    Referer: "https://www.instagram.com/",
    "X-IG-App-ID": "936619743392459",
    "X-Requested-With": "XMLHttpRequest"
  });
  if (env.IG_COOKIE) baseHeaders["Cookie"] = env.IG_COOKIE;

  let lastThumb = null;
  let sawVideoPost = expectVideo;

  // Accept a parse result only if it satisfies what the post actually is
  const accept = parsed => {
    if (parsed.thumbnail) lastThumb = parsed.thumbnail;
    if (parsed.isVideoPost) sawVideoPost = true;
    if (parsed.media.some(m => m.type === "video")) return true;       // got the video
    if (!sawVideoPost && parsed.media.length > 0) return true;         // genuine photo post
    return false;
  };

  const pages = [
    `https://www.instagram.com/p/${shortcode}/embed/captioned/`,
    `https://www.instagram.com/reel/${shortcode}/embed/captioned/`,
    `https://www.instagram.com/p/${shortcode}/embed/`,
    `https://www.instagram.com/p/${shortcode}/`
  ];

  for (const pageUrl of pages) {
    try {
      const res = await fetch(pageUrl, { headers: baseHeaders });
      if (!res.ok) continue;
      const parsed = parseInstagramHtml(await res.text());
      if (accept(parsed)) return parsed;
    } catch (_) { /* next strategy */ }
  }

  // GraphQL fallback
  try {
    const gqlUrl = `https://www.instagram.com/graphql/query/?query_hash=b3055c01b4b222b8a47dc12b090e4e64&variables=${encodeURIComponent(JSON.stringify({ shortcode }))}`;
    const gqlRes = await fetch(gqlUrl, { headers: baseHeaders });
    if (gqlRes.ok) {
      const node = (await gqlRes.json().catch(() => null))?.data?.shortcode_media;
      if (node) {
        const media = [];
        const title = node.edge_media_to_caption?.edges?.[0]?.node?.text || "Instagram Media";
        const thumbnail = node.display_url || null;
        const nodes = node.edge_sidecar_to_children?.edges ? node.edge_sidecar_to_children.edges.map(e => e.node) : [node];
        for (const n of nodes) {
          if (n.is_video && n.video_url) media.push({ url: n.video_url, quality: "HD", type: "video" });
          else if (!n.is_video && n.display_url) media.push({ url: n.display_url, quality: "HD", type: "image" });
        }
        if (media.length > 0) return { title: cleanText(title), thumbnail, media };
      }
    }
  } catch (_) { /* fall through */ }

  if (sawVideoPost) {
    throw new Error(
      env.IG_COOKIE
        ? "Instagram returned only the thumbnail for this video. The IG_COOKIE may have expired or the post is private."
        : "Instagram hides the video file from logged-out requests (only the thumbnail was available). Add 'IG_COOKIE' (sessionid cookie) in Cloudflare Worker Secrets to get the MP4."
    );
  }
  throw new Error(
    env.IG_COOKIE
      ? "Instagram blocked the request or the post is private. Verify your IG_COOKIE is still active."
      : "Instagram login wall encountered. Configure 'IG_COOKIE' in Cloudflare Worker Secrets for reliable extraction."
  );
}

async function extractPinterest(urlObj) {
  const res = await fetch(urlObj.toString(), { headers: getSpoofedHeaders({ Referer: "https://www.pinterest.com/" }) });
  if (!res.ok) throw new Error(`Pinterest returned HTTP ${res.status}`);

  const html = await res.text();
  const meta = parseUniversalHtmlMeta(html);
  const media = [...meta.media];

  const mp4Matches = html.match(/https:\/\/v1\.pinimg\.com\/videos\/[^\s"'\\]+\.mp4/g);
  if (mp4Matches && mp4Matches.length > 0) {
    for (const url of [...new Set(mp4Matches.map(u => decodeEscapedUrl(u)))]) {
      if (!media.some(m => m.url === url)) {
        media.unshift({ url, quality: url.includes("720p") || url.includes("1080p") ? "HD" : "SD", type: "video" });
      }
    }
  }

  if (media.length === 0) {
    const origImgMatch = html.match(/https:\/\/i\.pinimg\.com\/originals\/[^\s"'\\]+\.(?:jpg|png|webp|gif)/i);
    if (origImgMatch) media.push({ url: decodeEscapedUrl(origImgMatch[0]), quality: "HD", type: "image" });
    else if (meta.thumbnail) media.push({ url: meta.thumbnail, quality: "HD", type: "image" });
  }
  return { title: meta.title || "Pinterest Pin", thumbnail: meta.thumbnail, media };
}

async function extractFacebook(urlObj, env) {
  const headers = getSpoofedHeaders({
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    Referer: "https://www.facebook.com/"
  });
  if (env.FB_COOKIE) headers["Cookie"] = env.FB_COOKIE;

  const res = await fetch(urlObj.toString(), { headers });
  if (!res.ok) throw new Error(`Facebook returned HTTP ${res.status}`);

  const html = await res.text();
  const meta = parseUniversalHtmlMeta(html);
  const media = [];

  const hdPatterns = [
    /"browser_native_hd_url"\s*:\s*"([^"]+)"/, /"playable_url_quality_hd"\s*:\s*"([^"]+)"/,
    /"hd_src_no_ratelimit"\s*:\s*"([^"]+)"/, /"hd_src"\s*:\s*"([^"]+)"/
  ];
  const sdPatterns = [
    /"browser_native_sd_url"\s*:\s*"([^"]+)"/, /"playable_url"\s*:\s*"([^"]+)"/,
    /"sd_src_no_ratelimit"\s*:\s*"([^"]+)"/, /"sd_src"\s*:\s*"([^"]+)"/
  ];

  for (const pattern of hdPatterns) {
    const m = html.match(pattern);
    if (m && m[1] && m[1] !== "null") { media.push({ url: decodeEscapedUrl(m[1]), quality: "HD", type: "video" }); break; }
  }
  for (const pattern of sdPatterns) {
    const m = html.match(pattern);
    if (m && m[1] && m[1] !== "null") {
      const decoded = decodeEscapedUrl(m[1]);
      if (!media.some(x => x.url === decoded)) media.push({ url: decoded, quality: "SD", type: "video" });
      break;
    }
  }
  for (const item of meta.media) {
    if (!media.some(m => m.url === item.url)) media.push(item);
  }
  return { title: meta.title || "Facebook Video", thumbnail: meta.thumbnail, media };
}

/* ============================================================================
 * PARSING & UTILITY HELPERS
 * ========================================================================== */

function isYouTubeUrl(hostname) {
  const host = hostname.toLowerCase();
  return host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be" || host === "youtube-nocookie.com";
}

function detectPlatform(hostname) {
  const host = hostname.toLowerCase();
  if (host.includes("instagram.com")) return "instagram";
  if (host.includes("twitter.com") || host.includes("x.com") || host === "t.co") return "x";
  if (host.includes("pinterest.") || host === "pin.it") return "pinterest";
  if (host.includes("reddit.com") || host === "redd.it") return "reddit";
  if (host.includes("facebook.com") || host === "fb.watch" || host === "fb.com") return "facebook";
  return null;
}

function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function getSpoofedHeaders(extra = {}) {
  return {
    "User-Agent": getRandomUA(),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Upgrade-Insecure-Requests": "1",
    ...extra
  };
}

function parseUniversalHtmlMeta(html) {
  const media = [];
  let title = extractMetaContent(html, ["og:title", "twitter:title"]);
  let thumbnail = extractMetaContent(html, ["og:image", "twitter:image", "twitter:image:src"]);

  if (!title) {
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) title = cleanText(titleMatch[1]);
  }

  const videoUrl = extractMetaContent(html, ["og:video:secure_url", "og:video:url", "og:video", "twitter:player:stream"]);
  if (videoUrl && videoUrl.startsWith("http")) {
    media.push({ url: decodeHtmlEntities(videoUrl), quality: "HD", type: "video" });
  }

  const ldJsonRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = ldJsonRegex.exec(html)) !== null) {
    try {
      const jsonData = JSON.parse(match[1].trim());
      for (const item of Array.isArray(jsonData) ? jsonData : [jsonData]) {
        if (!title && (item.name || item.headline)) title = cleanText(item.name || item.headline);
        if (!thumbnail && item.thumbnailUrl) thumbnail = Array.isArray(item.thumbnailUrl) ? item.thumbnailUrl[0] : item.thumbnailUrl;
        const contentUrl = item.contentUrl || item.video?.contentUrl;
        if (contentUrl && typeof contentUrl === "string" && contentUrl.startsWith("http") && !media.some(m => m.url === contentUrl)) {
          media.push({ url: contentUrl, quality: "HD", type: "video" });
        }
      }
    } catch (_) { /* ignore malformed JSON-LD */ }
  }

  return {
    title: title ? decodeHtmlEntities(title) : null,
    thumbnail: thumbnail ? decodeHtmlEntities(thumbnail) : null,
    media
  };
}

/**
 * Instagram "efg" query parameter is base64 JSON such as {"vencode_tag":"CLIPS...video_default_cover_frame"}.
 * Anything tagged video/clips/cover_frame is a still frame of a video, not a photo post.
 */
function isInstagramCover(url) {
  try {
    const efg = new URL(url).searchParams.get("efg");
    if (efg) {
      const decoded = atob(efg.replace(/-/g, "+").replace(/_/g, "/"));
      if (/video|clips|cover_frame|reel/i.test(decoded)) return true;
    }
  } catch (_) { /* not decodable: treat as normal */ }
  return /cover_frame|video_default_cover/i.test(url);
}

function parseInstagramHtml(html) {
  const base = parseUniversalHtmlMeta(html);
  // The embed page ships its data as an escaped JSON string (\"video_url\":\"https:\\/\\/...\"). Un-escape quotes so one set of regexes works for both.
  const norm = html.replace(/\\+"/g, '"');

  const media = [];
  const seen = new Set();
  let thumbnail = base.thumbnail;

  const add = (url, type, quality = "HD") => {
    if (!url || !url.startsWith("http")) return;
    const key = url.split("?")[0];
    if (seen.has(key)) return;
    seen.add(key);
    media.push({ url, quality, type });
  };

  // ---- Videos ----
  for (const item of base.media) {
    if (item.type === "video") add(item.url, "video", item.quality);
  }
  for (const m of norm.matchAll(/"video_url"\s*:\s*"([^"]+)"/g)) add(decodeEscapedUrl(m[1]), "video");
  for (const m of norm.matchAll(/"video_versions"\s*:\s*\[\s*\{[^\]]*?"url"\s*:\s*"([^"]+)"/g)) add(decodeEscapedUrl(m[1]), "video");

  const hasVideo = media.some(m => m.type === "video");
  const isCarousel = /edge_sidecar_to_children|carousel_media/.test(norm);
  const isVideoPost =
    hasVideo ||
    /"is_video"\s*:\s*true/.test(norm) ||
    /"__typename"\s*:\s*"(?:Graph|XDTGraph)Video"/.test(norm) ||
    /"video_duration"\s*:\s*[\d.]+/.test(norm) ||
    /"media_type"\s*:\s*2\b/.test(norm);

  // ---- Photos (only for real photo posts / carousels; never video cover frames) ----
  if (!isVideoPost || isCarousel) {
    const candidates = [];
    for (const m of norm.matchAll(/"display_url"\s*:\s*"([^"]+)"/g)) candidates.push(decodeEscapedUrl(m[1]));
    for (const m of html.matchAll(/class=["'][^"']*EmbeddedMediaImage[^"']*["'][^>]+src=["']([^"']+)["']/gi)) candidates.push(decodeHtmlEntities(m[1]));

    for (const url of candidates) {
      if (isLowResOrAvatarInstagramImage(url)) continue;
      if (isInstagramCover(url)) { if (!thumbnail) thumbnail = url; continue; }
      add(url, "image");
    }
  }

  return { title: base.title || "Instagram Media", thumbnail, media, isVideoPost };
}

function isLowResOrAvatarInstagramImage(url) {
  if (!url) return true;
  const lower = url.toLowerCase();
  return (
    lower.includes("/s150x150/") || lower.includes("/p150x150/") || lower.includes("/s100x100/") ||
    lower.includes("/s64x64/") || lower.includes("/s320x320/") ||
    lower.includes("profile_pic") || lower.includes("t51.2885-19")
  );
}

function computeSyndicationToken(idStr) {
  return ((Number(idStr) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

function parseSyndicationData(data) {
  const title = cleanText(data.text || "X Media");
  let thumbnail = data.photos?.[0]?.url || null;
  const media = [];

  if (Array.isArray(data.mediaDetails)) {
    for (const item of data.mediaDetails) {
      if (!thumbnail && item.media_url_https) thumbnail = item.media_url_https;
      if (item.type === "video" || item.type === "animated_gif") {
        const variants = (item.video_info?.variants || [])
          .filter(v => v.content_type === "video/mp4")
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
        if (variants.length > 0) {
          media.push({ url: variants[0].url, quality: (variants[0].bitrate || 0) >= 2000000 ? "HD" : "SD", type: "video" });
        }
      } else if (item.type === "photo" && item.media_url_https) {
        media.push({ url: `${item.media_url_https}?name=orig`, quality: "HD", type: "image" });
      }
    }
  }
  return { title, thumbnail, media };
}

function extractMetaContent(html, propNames) {
  for (const name of propNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m1 = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i"));
    if (m1 && m1[1]) return m1[1];
    const m2 = html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`, "i"));
    if (m2 && m2[1]) return m2[1];
  }
  return null;
}

function decodeEscapedUrl(str) {
  return decodeHtmlEntities(
    str
      .replace(/\\+u0026/gi, "&")
      .replace(/\\+u0025/gi, "%")
      .replace(/\\+\//g, "/")
      .replace(/\\"/g, '"')
  );
}

function decodeHtmlEntities(str) {
  if (!str) return "";
  return str
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x2F;/g, "/");
}

function cleanText(str) {
  return decodeHtmlEntities(str).replace(/\s+/g, " ").trim();
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), { status, headers: CORS_HEADERS });
}
