/**
 * Cloudflare Worker: Universal Social Media Media Downloader API
 * Runtime: ES Modules (V8 Isolate - Zero external dependencies)
 */

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36"
];

// Public Twitter Web App Bearer Token & Default TweetResultByRestId GraphQL Query ID
const TWITTER_BEARER_TOKEN = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const DEFAULT_X_GRAPHQL_ID = "0hWvDhmW8YQ-S_ib3azIrw";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json; charset=utf-8"
};

export default {
  async fetch(request, env, ctx) {
    // 1. Handle CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      // 2. Extract URL from GET query or POST JSON body
      let targetUrl = null;
      const reqUrl = new URL(request.url);

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

      // Validate URL format & SSRF rules
      let parsedUrl;
      try {
        parsedUrl = new URL(targetUrl.trim());
      } catch {
        return jsonResponse({ success: false, error: "Invalid URL format provided." }, 400);
      }

      const ssrfCheck = validateSafeUrl(parsedUrl);
      if (!ssrfCheck.valid) {
        return jsonResponse({ success: false, error: ssrfCheck.reason }, 400);
      }

      // 3. Strictly Exclude YouTube (Pre-redirect check)
      if (isYouTubeUrl(parsedUrl.hostname)) {
        return jsonResponse({ success: false, error: "YouTube downloads are not supported" }, 400);
      }

      // 4. Resolve shortened URLs safely with SSRF validation across hops
      const resolvedUrlStr = await resolveRedirects(parsedUrl.toString());
      const resolvedUrl = new URL(resolvedUrlStr);

      const postRedirectSsrfCheck = validateSafeUrl(resolvedUrl);
      if (!postRedirectSsrfCheck.valid) {
        return jsonResponse({ success: false, error: postRedirectSsrfCheck.reason }, 400);
      }

      // Re-verify YouTube exclusion after resolving shortened URLs
      if (isYouTubeUrl(resolvedUrl.hostname)) {
        return jsonResponse({ success: false, error: "YouTube downloads are not supported" }, 400);
      }

      // 5. Route by Platform
      const platform = detectPlatform(resolvedUrl.hostname);
      if (!platform) {
        return jsonResponse({
          success: false,
          error: `Unsupported platform (${resolvedUrl.hostname}). Supported: Instagram, X/Twitter, Pinterest, Reddit, Facebook.`
        }, 400);
      }

      let result;
      switch (platform) {
        case "x":
          result = await extractX(resolvedUrl, env);
          break;
        case "reddit":
          result = await extractReddit(resolvedUrl);
          break;
        case "instagram":
          result = await extractInstagram(resolvedUrl, env);
          break;
        case "pinterest":
          result = await extractPinterest(resolvedUrl);
          break;
        case "facebook":
          result = await extractFacebook(resolvedUrl, env);
          break;
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
        media: result.media
      }, 200);

    } catch (err) {
      return jsonResponse({
        success: false,
        error: err.message || "Internal Worker extraction error."
      }, 500);
    }
  }
};

/* ============================================================================
 * SSRF VALIDATION & SAFE REDIRECT RESOLUTION
 * ========================================================================== */

/**
 * Validates that a URL object uses http/https and does not point to
 * loopback, private, link-local, or internal hostnames/IP ranges.
 */
function validateSafeUrl(urlObj) {
  if (urlObj.protocol !== "http:" && urlObj.protocol !== "https:") {
    return { valid: false, reason: "Invalid URL protocol. Only HTTP and HTTPS are allowed." };
  }

  // Strip IPv6 brackets if present
  const hostname = urlObj.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  ) {
    return { valid: false, reason: "Access to local or internal hostnames is forbidden." };
  }

  // IPv6 loopback, unspecified, link-local (fe80::/10), unique local (fc00::/7), or IPv4-mapped IPv6
  if (hostname.includes(":")) {
    if (
      hostname === "::1" ||
      hostname === "::" ||
      hostname === "0:0:0:0:0:0:0:1" ||
      hostname === "0:0:0:0:0:0:0:0" ||
      hostname.startsWith("fe80:") ||
      hostname.startsWith("fc") ||
      hostname.startsWith("fd") ||
      hostname.startsWith("::ffff:")
    ) {
      return { valid: false, reason: "Access to private or loopback IPv6 addresses is forbidden." };
    }
  }

  // IPv4 numeric validation
  const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const ipv4Match = hostname.match(ipv4Regex);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1, 5).map(Number);
    if (octets.some(o => o > 255)) {
      return { valid: false, reason: "Invalid IPv4 address." };
    }
    const [a, b] = octets;
    if (
      a === 0 ||                                // 0.0.0.0/8 (Current network)
      a === 10 ||                               // 10.0.0.0/8 (Private)
      a === 127 ||                              // 127.0.0.0/8 (Loopback)
      (a === 169 && b === 254) ||               // 169.254.0.0/16 (Link-local / Cloud metadata)
      (a === 172 && b >= 16 && b <= 31) ||      // 172.16.0.0/12 (Private)
      (a === 192 && b === 168) ||               // 192.168.0.0/16 (Private)
      (a === 100 && b >= 64 && b <= 127)        // 100.64.0.0/10 (Carrier-grade NAT)
    ) {
      return { valid: false, reason: "Access to private, loopback, or reserved IPv4 ranges is forbidden." };
    }
  }

  return { valid: true };
}

/**
 * Resolves redirects step-by-step (up to 5 hops) while validating every intermediate
 * Location target against SSRF rules before fetching.
 */
async function resolveRedirects(initialUrl, maxRedirects = 5) {
  let currentUrl = initialUrl;

  for (let i = 0; i < maxRedirects; i++) {
    let parsedCurrent;
    try {
      parsedCurrent = new URL(currentUrl);
    } catch {
      throw new Error("Malformed URL encountered during redirect resolution.");
    }

    const check = validateSafeUrl(parsedCurrent);
    if (!check.valid) {
      throw new Error(check.reason);
    }

    let res;
    try {
      res = await fetch(currentUrl, {
        method: "HEAD",
        redirect: "manual",
        headers: getSpoofedHeaders()
      });
      // Some servers reject HEAD with 405/403; retry with manual GET
      if (res.status === 405 || res.status === 403) {
        res = await fetch(currentUrl, {
          method: "GET",
          redirect: "manual",
          headers: getSpoofedHeaders()
        });
      }
    } catch {
      break;
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) break;

      const nextUrl = new URL(location, currentUrl);
      const nextCheck = validateSafeUrl(nextUrl);
      if (!nextCheck.valid) {
        throw new Error(`Redirect blocked: ${nextCheck.reason}`);
      }
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

/**
 * X / Twitter Extractor
 * Uses Syndication API first, then falls back to Guest Token + Configurable GraphQL Query ID
 */
async function extractX(urlObj, env) {
  const match = urlObj.pathname.match(/\/(?:status|statuses)\/(\d+)/);
  if (!match) {
    throw new Error("Could not find a valid Tweet/X status ID in the URL.");
  }
  const tweetId = match[1];

  // Method 1: Syndication Endpoint
  try {
    const token = computeSyndicationToken(tweetId);
    const syndicationUrl = `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en&token=${token}`;
    const res = await fetch(syndicationUrl, {
      headers: getSpoofedHeaders({ Referer: "https://platform.twitter.com/" })
    });

    if (res.ok) {
      const data = await res.json();
      const parsed = parseSyndicationData(data);
      if (parsed && parsed.media.length > 0) return parsed;
    }
  } catch (_) {
    // Fall through to Method 2
  }

  // Method 2: Activate Guest Token + Query Configurable GraphQL Endpoint
  const bearer = env.X_BEARER_TOKEN || TWITTER_BEARER_TOKEN;
  const graphqlQueryId = (env.X_GRAPHQL_ID && env.X_GRAPHQL_ID.trim()) || DEFAULT_X_GRAPHQL_ID;

  const guestRes = await fetch("https://api.x.com/1.1/guest/activate.json", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${bearer}`,
      "User-Agent": getRandomUA()
    }
  });

  if (!guestRes.ok) {
    throw new Error("Failed to acquire X Guest Token and Syndication fallback returned no media.");
  }

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

  const variables = {
    tweetId: tweetId,
    withCommunity: false,
    includePromotedContent: false,
    withVoice: false
  };

  const graphqlUrl = `https://api.x.com/graphql/${encodeURIComponent(graphqlQueryId)}/TweetResultByRestId?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent(JSON.stringify(features))}`;

  const gqlRes = await fetch(graphqlUrl, {
    headers: {
      "Authorization": `Bearer ${bearer}`,
      "x-guest-token": guest_token,
      "User-Agent": getRandomUA(),
      "Accept": "application/json"
    }
  });

  if (!gqlRes.ok) {
    if (gqlRes.status === 400 || gqlRes.status === 404) {
      throw new Error(
        `X GraphQL endpoint returned HTTP ${gqlRes.status}. The GraphQL Query ID (${graphqlQueryId}) may have rotated—update X_GRAPHQL_ID in Worker Secrets.`
      );
    }
    throw new Error(`X GraphQL request failed with status ${gqlRes.status}`);
  }

  const gqlData = await gqlRes.json().catch(() => null);
  if (!gqlData || (gqlData.errors && !gqlData.data)) {
    const errMsg = gqlData?.errors?.[0]?.message || "Invalid GraphQL response structure.";
    throw new Error(`X GraphQL query error: ${errMsg}. Consider updating X_GRAPHQL_ID.`);
  }

  const legacy = gqlData?.data?.tweetResult?.result?.legacy || gqlData?.data?.tweetResult?.result?.tweet?.legacy;
  if (!legacy) {
    throw new Error("Tweet data unavailable, age-restricted, or protected.");
  }

  const title = cleanText(legacy.full_text || "X Video");
  let thumbnail = null;
  const mediaList = [];

  const entities = legacy.extended_entities?.media || legacy.entities?.media || [];
  for (const item of entities) {
    if (!thumbnail && item.media_url_https) {
      thumbnail = item.media_url_https;
    }

    if (item.type === "video" || item.type === "animated_gif") {
      const variants = (item.video_info?.variants || [])
        .filter(v => v.content_type === "video/mp4")
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      if (variants.length > 0) {
        mediaList.push({
          url: variants[0].url,
          quality: variants[0].bitrate >= 2000000 ? "HD" : "SD",
          type: "video"
        });
      }
    } else if (item.type === "photo" && item.media_url_https) {
      mediaList.push({
        url: `${item.media_url_https}?name=orig`,
        quality: "HD",
        type: "image"
      });
    }
  }

  return { title, thumbnail, media: mediaList };
}

/**
 * Reddit Extractor
 * Uses the .json suffix trick and probes v.redd.it DASH audio streams via HEAD requests
 */
async function extractReddit(urlObj) {
  const cleanPath = urlObj.pathname.replace(/\/+$/, "");
  const jsonUrl = `https://www.reddit.com${cleanPath}.json?raw_json=1`;

  const res = await fetch(jsonUrl, {
    headers: getSpoofedHeaders({
      Accept: "application/json",
      Referer: "https://www.reddit.com/"
    })
  });

  if (!res.ok) {
    throw new Error(`Reddit API returned HTTP ${res.status}`);
  }

  const data = await res.json();
  const post = Array.isArray(data)
    ? data[0]?.data?.children?.[0]?.data
    : data?.data?.children?.[0]?.data;

  if (!post) {
    throw new Error("Unable to parse Reddit post data.");
  }

  const targetPost = (post.crosspost_parent_list && post.crosspost_parent_list[0]) || post;

  const title = targetPost.title || "Reddit Media";
  let thumbnail = targetPost.preview?.images?.[0]?.source?.url || targetPost.thumbnail || null;
  if (thumbnail && !thumbnail.startsWith("http")) thumbnail = null;

  const media = [];

  // 1. Native Reddit Video (v.redd.it) + DASH Audio Stream Probing
  const redditVideo = targetPost.secure_media?.reddit_video || targetPost.media?.reddit_video || targetPost.preview?.reddit_video_preview;
  if (redditVideo && redditVideo.fallback_url) {
    const cleanVideoUrl = redditVideo.fallback_url.split("?")[0];
    media.push({
      url: cleanVideoUrl,
      quality: redditVideo.height >= 720 ? "HD" : "SD",
      type: "video"
    });

    // Probe for separate DASH audio stream if this isn't a silent GIF
    if (!redditVideo.is_gif) {
      const basePath = cleanVideoUrl.substring(0, cleanVideoUrl.lastIndexOf("/"));
      if (basePath.startsWith("http")) {
        const audioCandidates = [
          `${basePath}/DASH_AUDIO_128.mp4`,
          `${basePath}/DASH_AUDIO_64.mp4`,
          `${basePath}/DASH_audio.mp4`,
          `${basePath}/audio`
        ];

        for (const candidateUrl of audioCandidates) {
          try {
            const audioHead = await fetch(candidateUrl, {
              method: "HEAD",
              headers: getSpoofedHeaders({ Referer: "https://www.reddit.com/" })
            });
            if (audioHead.ok && audioHead.status === 200) {
              media.push({
                url: candidateUrl,
                quality: "Audio",
                type: "audio"
              });
              break;
            }
          } catch (_) {
            // Try next audio filename candidate
          }
        }
      }
    }
  }

  // 2. Reddit Gallery
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

  // 3. Direct Image or MP4 Preview
  if (media.length === 0) {
    const mp4Variant = targetPost.preview?.images?.[0]?.variants?.mp4?.source?.url;
    if (mp4Variant) {
      media.push({
        url: decodeHtmlEntities(mp4Variant),
        quality: "HD",
        type: "video"
      });
    } else if (targetPost.url_overridden_by_dest && /\.(jpg|jpeg|png|webp|gif|mp4)$/i.test(targetPost.url_overridden_by_dest)) {
      const isVideo = /\.mp4$/i.test(targetPost.url_overridden_by_dest);
      media.push({
        url: targetPost.url_overridden_by_dest,
        quality: "HD",
        type: isVideo ? "video" : "image"
      });
    }
  }

  return { title, thumbnail, media };
}

/**
 * Instagram Extractor
 * Tries public Embed/Captioned endpoint first, then authenticated page/GraphQL fetch using env.IG_COOKIE
 */
async function extractInstagram(urlObj, env) {
  const match = urlObj.pathname.match(/\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  if (!match) {
    throw new Error("Invalid Instagram URL. Provide a link to a Reel, Post, or Video (/p/, /reel/, or /tv/).");
  }
  const shortcode = match[2];

  // Attempt 1: Public Embed Endpoint
  const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned/`;
  const embedHeaders = getSpoofedHeaders({
    Referer: "https://www.instagram.com/"
  });
  if (env.IG_COOKIE) {
    embedHeaders["Cookie"] = env.IG_COOKIE;
  }

  const embedRes = await fetch(embedUrl, { headers: embedHeaders });
  if (embedRes.ok) {
    const html = await embedRes.text();
    const parsedEmbed = parseInstagramHtml(html);
    if (parsedEmbed.media.length > 0) {
      return parsedEmbed;
    }
  }

  // Attempt 2: Direct Page / JSON Query (Uses env.IG_COOKIE if provided)
  const postHeaders = getSpoofedHeaders({
    Referer: "https://www.instagram.com/",
    "X-IG-App-ID": "936619743392459",
    "X-Requested-With": "XMLHttpRequest"
  });

  if (env.IG_COOKIE) {
    postHeaders["Cookie"] = env.IG_COOKIE;
  }

  const pageUrl = `https://www.instagram.com/p/${shortcode}/`;
  const pageRes = await fetch(pageUrl, { headers: postHeaders });

  if (pageRes.ok) {
    const pageHtml = await pageRes.text();
    const parsedPage = parseInstagramHtml(pageHtml);
    if (parsedPage.media.length > 0) {
      return parsedPage;
    }
  }

  // Attempt 3: Instagram GraphQL Query endpoint
  const gqlUrl = `https://www.instagram.com/graphql/query/?query_hash=b3055c01b4b222b8a47dc12b090e4e64&variables=${encodeURIComponent(JSON.stringify({ shortcode }))}`;
  const gqlRes = await fetch(gqlUrl, { headers: postHeaders });

  if (gqlRes.ok) {
    const gqlJson = await gqlRes.json().catch(() => null);
    const mediaNode = gqlJson?.data?.shortcode_media;
    if (mediaNode) {
      const media = [];
      const title = mediaNode.edge_media_to_caption?.edges?.[0]?.node?.text || "Instagram Media";
      const thumbnail = mediaNode.display_url || null;

      if (mediaNode.edge_sidecar_to_children?.edges) {
        for (const edge of mediaNode.edge_sidecar_to_children.edges) {
          const node = edge.node;
          if (node.is_video && node.video_url) {
            media.push({ url: node.video_url, quality: "HD", type: "video" });
          } else if (node.display_url) {
            media.push({ url: node.display_url, quality: "HD", type: "image" });
          }
        }
      } else if (mediaNode.is_video && mediaNode.video_url) {
        media.push({ url: mediaNode.video_url, quality: "HD", type: "video" });
      } else if (mediaNode.display_url) {
        media.push({ url: mediaNode.display_url, quality: "HD", type: "image" });
      }

      if (media.length > 0) {
        return { title: cleanText(title), thumbnail, media };
      }
    }
  }

  throw new Error(
    env.IG_COOKIE
      ? "Instagram blocked the request or the post is private. Verify your IG_COOKIE is still active."
      : "Instagram login wall encountered. Configure 'IG_COOKIE' in Cloudflare Worker Secrets for reliable extraction."
  );
}

/**
 * Pinterest Extractor
 * Parses __PWS_DATA__, JSON-LD, and OpenGraph tags
 */
async function extractPinterest(urlObj) {
  const res = await fetch(urlObj.toString(), {
    headers: getSpoofedHeaders({ Referer: "https://www.pinterest.com/" })
  });

  if (!res.ok) {
    throw new Error(`Pinterest returned HTTP ${res.status}`);
  }

  const html = await res.text();
  const meta = parseUniversalHtmlMeta(html);
  const media = [...meta.media];

  // Look for direct 720p/1080p MP4 streams in Pinterest's embedded state (__PWS_DATA__)
  const mp4Matches = html.match(/https:\/\/v1\.pinimg\.com\/videos\/[^\s"'\\]+\.mp4/g);
  if (mp4Matches && mp4Matches.length > 0) {
    const uniqueMp4s = [...new Set(mp4Matches.map(u => decodeEscapedUrl(u)))];
    for (const url of uniqueMp4s) {
      if (!media.some(m => m.url === url)) {
        media.unshift({
          url,
          quality: url.includes("720p") || url.includes("1080p") ? "HD" : "SD",
          type: "video"
        });
      }
    }
  }

  // Fallback to high-res image pin if no video found
  if (media.length === 0) {
    const origImgMatch = html.match(/https:\/\/i\.pinimg\.com\/originals\/[^\s"'\\]+\.(?:jpg|png|webp|gif)/i);
    if (origImgMatch) {
      media.push({
        url: decodeEscapedUrl(origImgMatch[0]),
        quality: "HD",
        type: "image"
      });
    } else if (meta.thumbnail) {
      media.push({
        url: meta.thumbnail,
        quality: "HD",
        type: "image"
      });
    }
  }

  return {
    title: meta.title || "Pinterest Pin",
    thumbnail: meta.thumbnail,
    media
  };
}

/**
 * Facebook Public Video Extractor
 * Extracts HD/SD MP4 streams from embedded Relay JSON and OpenGraph tags
 */
async function extractFacebook(urlObj, env) {
  const headers = getSpoofedHeaders({
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    Referer: "https://www.facebook.com/"
  });
  if (env.FB_COOKIE) {
    headers["Cookie"] = env.FB_COOKIE;
  }

  const res = await fetch(urlObj.toString(), { headers });
  if (!res.ok) {
    throw new Error(`Facebook returned HTTP ${res.status}`);
  }

  const html = await res.text();
  const meta = parseUniversalHtmlMeta(html);
  const media = [];

  const hdPatterns = [
    /"browser_native_hd_url"\s*:\s*"([^"]+)"/,
    /"playable_url_quality_hd"\s*:\s*"([^"]+)"/,
    /"hd_src_no_ratelimit"\s*:\s*"([^"]+)"/,
    /"hd_src"\s*:\s*"([^"]+)"/
  ];

  const sdPatterns = [
    /"browser_native_sd_url"\s*:\s*"([^"]+)"/,
    /"playable_url"\s*:\s*"([^"]+)"/,
    /"sd_src_no_ratelimit"\s*:\s*"([^"]+)"/,
    /"sd_src"\s*:\s*"([^"]+)"/
  ];

  for (const pattern of hdPatterns) {
    const match = html.match(pattern);
    if (match && match[1] && match[1] !== "null") {
      media.push({
        url: decodeEscapedUrl(match[1]),
        quality: "HD",
        type: "video"
      });
      break;
    }
  }

  for (const pattern of sdPatterns) {
    const match = html.match(pattern);
    if (match && match[1] && match[1] !== "null") {
      const decoded = decodeEscapedUrl(match[1]);
      if (!media.some(m => m.url === decoded)) {
        media.push({
          url: decoded,
          quality: "SD",
          type: "video"
        });
      }
      break;
    }
  }

  for (const item of meta.media) {
    if (!media.some(m => m.url === item.url)) {
      media.push(item);
    }
  }

  return {
    title: meta.title || "Facebook Video",
    thumbnail: meta.thumbnail,
    media
  };
}

/* ============================================================================
 * PARSING & UTILITY HELPERS
 * ========================================================================== */

function isYouTubeUrl(hostname) {
  const host = hostname.toLowerCase();
  return (
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtu.be" ||
    host === "youtube-nocookie.com"
  );
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

/**
 * Universal HTML Metadata Parser (OpenGraph, Twitter Cards, JSON-LD)
 */
function parseUniversalHtmlMeta(html) {
  const media = [];
  let title = extractMetaContent(html, ["og:title", "twitter:title"]);
  let thumbnail = extractMetaContent(html, ["og:image", "twitter:image", "twitter:image:src"]);

  if (!title) {
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) title = cleanText(titleMatch[1]);
  }

  const videoUrl = extractMetaContent(html, [
    "og:video:secure_url",
    "og:video:url",
    "og:video",
    "twitter:player:stream"
  ]);

  if (videoUrl && videoUrl.startsWith("http")) {
    media.push({
      url: decodeHtmlEntities(videoUrl),
      quality: "HD",
      type: "video"
    });
  }

  const ldJsonRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = ldJsonRegex.exec(html)) !== null) {
    try {
      const jsonData = JSON.parse(match[1].trim());
      const items = Array.isArray(jsonData) ? jsonData : [jsonData];
      for (const item of items) {
        if (!title && (item.name || item.headline)) {
          title = cleanText(item.name || item.headline);
        }
        if (!thumbnail && item.thumbnailUrl) {
          thumbnail = Array.isArray(item.thumbnailUrl) ? item.thumbnailUrl[0] : item.thumbnailUrl;
        }
        const contentUrl = item.contentUrl || item.video?.contentUrl;
        if (contentUrl && typeof contentUrl === "string" && contentUrl.startsWith("http")) {
          if (!media.some(m => m.url === contentUrl)) {
            media.push({
              url: contentUrl,
              quality: "HD",
              type: "video"
            });
          }
        }
      }
    } catch (_) {
      // Ignore malformed JSON-LD blocks
    }
  }

  return {
    title: title ? decodeHtmlEntities(title) : null,
    thumbnail: thumbnail ? decodeHtmlEntities(thumbnail) : null,
    media
  };
}

/**
 * Instagram HTML & Embedded JSON Parser
 * Extracts all unique videos and high-res carousel images while filtering out avatars/thumbnails
 */
function parseInstagramHtml(html) {
  const base = parseUniversalHtmlMeta(html);
  const media = [];
  const seenUrls = new Set();

  const addMediaItem = (url, type, quality = "HD") => {
    if (!url || !url.startsWith("http")) return;
    // Normalize URL key without volatile byte-range query params for deduplication
    const dedupeKey = url.split("?")[0];
    if (seenUrls.has(dedupeKey) || seenUrls.has(url)) return;
    seenUrls.add(dedupeKey);
    seenUrls.add(url);
    media.push({ url, quality, type });
  };

  for (const item of base.media) {
    addMediaItem(item.url, item.type, item.quality);
  }

  // 1. Extract escaped video_url from embedded Instagram scripts
  const videoUrlMatches = html.matchAll(/"video_url"\s*:\s*"([^"]+)"/g);
  for (const m of videoUrlMatches) {
    addMediaItem(decodeEscapedUrl(m[1]), "video", "HD");
  }

  // 2. Extract video_versions array from Polaris/Relay JSON
  const versionMatches = html.matchAll(/"video_versions"\s*:\s*\[\s*\{[^}]*"url"\s*:\s*"([^"]+)"/g);
  for (const m of versionMatches) {
    addMediaItem(decodeEscapedUrl(m[1]), "video", "HD");
  }

  // 3. Extract all high-res display_url / display_resources images (supporting mixed carousels)
  const displayMatches = html.matchAll(/"display_url"\s*:\s*"([^"]+)"/g);
  for (const m of displayMatches) {
    const url = decodeEscapedUrl(m[1]);
    if (!isLowResOrAvatarInstagramImage(url)) {
      addMediaItem(url, "image", "HD");
    }
  }

  // 4. Also check Embed HTML class="EmbeddedMediaImage" src attributes for single image embeds
  const embedImgMatches = html.matchAll(/class=["'][^"']*EmbeddedMediaImage[^"']*["'][^>]+src=["']([^"']+)["']/gi);
  for (const m of embedImgMatches) {
    const url = decodeHtmlEntities(m[1]);
    if (!isLowResOrAvatarInstagramImage(url)) {
      addMediaItem(url, "image", "HD");
    }
  }

  return {
    title: base.title || "Instagram Media",
    thumbnail: base.thumbnail,
    media
  };
}

/**
 * Filters out small profile avatars (s150x150, p150x150, etc.) and static UI assets
 */
function isLowResOrAvatarInstagramImage(url) {
  if (!url) return true;
  const lower = url.toLowerCase();
  if (
    lower.includes("/s150x150/") ||
    lower.includes("/p150x150/") ||
    lower.includes("/s100x100/") ||
    lower.includes("/s64x64/") ||
    lower.includes("/s320x320/") ||
    lower.includes("profile_pic") ||
    lower.includes("t51.2885-19") // Instagram's CDN path bucket for user profile avatars
  ) {
    return true;
  }
  return false;
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
      if (!thumbnail && item.media_url_https) {
        thumbnail = item.media_url_https;
      }
      if (item.type === "video" || item.type === "animated_gif") {
        const variants = (item.video_info?.variants || [])
          .filter(v => v.content_type === "video/mp4")
          .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

        if (variants.length > 0) {
          media.push({
            url: variants[0].url,
            quality: (variants[0].bitrate || 0) >= 2000000 ? "HD" : "SD",
            type: "video"
          });
        }
      } else if (item.type === "photo" && item.media_url_https) {
        media.push({
          url: `${item.media_url_https}?name=orig`,
          quality: "HD",
          type: "image"
        });
      }
    }
  }

  return { title, thumbnail, media };
}

function extractMetaContent(html, propNames) {
  for (const name of propNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex1 = new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i");
    const match1 = html.match(regex1);
    if (match1 && match1[1]) return match1[1];

    const regex2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`, "i");
    const match2 = html.match(regex2);
    if (match2 && match2[1]) return match2[1];
  }
  return null;
}

function decodeEscapedUrl(str) {
  return decodeHtmlEntities(
    str
      .replace(/\\u0026/g, "&")
      .replace(/\\u0025/g, "%")
      .replace(/\\\//g, "/")
      .replace(/\\"/g, '"')
  );
}

function decodeHtmlEntities(str) {
  if (!str) return "";
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, "/");
}

function cleanText(str) {
  return decodeHtmlEntities(str).replace(/\s+/g, " ").trim();
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: CORS_HEADERS
  });
}
