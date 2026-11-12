/**
 * Multi-Platform Media Extractor & CORS Streaming Proxy
 * Supports: YouTube (InnerTube 1080p/4K MP4 + M4A), Instagram, Threads, Twitter/X, Facebook, Snapchat
 * Zero Paid APIs | Modular Architecture
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range, Authorization, X-Requested-With",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Type",
  "Cross-Origin-Resource-Policy": "cross-origin"
};

const DEFAULT_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";

// ==========================================
// 1. MODULAR PLATFORM REGISTRY (പുതിയവ ഇവിടെ ചേർക്കാം)
// ==========================================
const PLATFORM_HANDLERS = [
  {
    name: "youtube",
    match: (url) => /(?:youtube\.com|youtu\.be)/i.test(url),
    handler: extractYouTube
  },
  {
    name: "instagram",
    match: (url) => /instagram\.com/i.test(url),
    handler: extractInstagram
  },
  {
    name: "threads",
    match: (url) => /threads\.(?:net|com)/i.test(url),
    handler: extractThreads
  },
  {
    name: "twitter",
    match: (url) => /(?:twitter\.com|x\.com)/i.test(url),
    handler: extractTwitter
  },
  {
    name: "facebook",
    match: (url) => /(?:facebook\.com|fb\.watch|fb\.com)/i.test(url),
    handler: extractFacebook
  },
  {
    name: "snapchat",
    match: (url) => /snapchat\.com/i.test(url),
    handler: extractSnapchat
  }
  // ഭാവിയിൽ പുതിയ പ്ലാറ്റ്‌ഫോം ചേർക്കാൻ:
  // { name: "pinterest", match: (url) => /pinterest\.com|pin\.it/i.test(url), handler: extractPinterest }
];

// ==========================================
// 2. WORKER ENTRY POINT & ROUTER
// ==========================================
export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const reqUrl = new URL(request.url);
    const pathname = reqUrl.pathname;

    try {
      // റൂട്ട് 1: Built-in CORS Media Proxy (/proxy?url=...)
      if (pathname === "/proxy") {
        const mediaUrl = reqUrl.searchParams.get("url");
        if (!mediaUrl) {
          return jsonResponse({ status: "error", message: "Missing 'url' parameter for proxy." }, 400);
        }
        return await handleProxyRequest(request, mediaUrl);
      }

      // റൂട്ട് 2: Media Extraction (GET /?url=... അല്ലെങ്കിൽ POST /)
      let targetUrl = reqUrl.searchParams.get("url");
      if (!targetUrl && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        targetUrl = body.url;
      }

      if (!targetUrl) {
        return jsonResponse(
          {
            status: "error",
            message: "Provide a target link via ?url= or POST JSON body.",
            endpoints: {
              extract: "/?url=<SOCIAL_MEDIA_URL>",
              proxy: "/proxy?url=<ENCODED_MEDIA_STREAM_URL>"
            }
          },
          400
        );
      }

      // പ്ലാറ്റ്‌ഫോം തിരിച്ചറിഞ്ഞ് അതിന്റെ ഫങ്ഷൻ പ്രവർത്തിപ്പിക്കുന്നു
      const platformModule = PLATFORM_HANDLERS.find((p) => p.match(targetUrl));
      if (!platformModule) {
        return jsonResponse({ status: "error", message: "Unsupported platform URL." }, 400);
      }

      const rawData = await platformModule.handler(targetUrl, reqUrl.origin);
      return jsonResponse(createUnifiedResponse(platformModule.name, targetUrl, rawData, reqUrl.origin));
    } catch (err) {
      return jsonResponse(
        {
          status: "error",
          message: err.message || "Extraction failed",
          stack: err.stack ? err.stack.split("\n")[0] : undefined
        },
        500
      );
    }
  }
};

// ==========================================
// 3. UNIFIED JSON OUTPUT BUILDER
// ==========================================
function createUnifiedResponse(platform, originalUrl, data, workerOrigin) {
  const wrapProxy = (mediaUrl) =>
    mediaUrl ? `${workerOrigin}/proxy?url=${encodeURIComponent(mediaUrl)}` : null;

  return {
    status: "success",
    platform,
    originalUrl,
    title: data.title || `${platform.toUpperCase()} Media`,
    thumbnail: data.thumbnail || null,
    proxiedThumbnail: wrapProxy(data.thumbnail),
    // സാധാരണ വീഡിയോ+ഓഡിയോ ഒന്നിച്ചുള്ള ഫയലുകൾ
    videos: (data.videos || []).map((v) => ({
      quality: v.quality || "HD",
      mimeType: v.mimeType || "video/mp4",
      width: v.width || null,
      height: v.height || null,
      url: v.url,
      proxyUrl: wrapProxy(v.url)
    })),
    // YouTube 1080p/4K പോലുള്ള Video-Only MP4 സ്ട്രീമുകൾ (MP4Box.js-ന് വേണ്ടി)
    dashVideos: (data.dashVideos || []).map((dv) => ({
      itag: dv.itag || null,
      quality: dv.quality || `${dv.height}p`,
      width: dv.width || null,
      height: dv.height || null,
      fps: dv.fps || 30,
      codecs: dv.codecs || "avc1",
      mimeType: dv.mimeType || "video/mp4",
      contentLength: dv.contentLength ? Number(dv.contentLength) : null,
      url: dv.url,
      proxyUrl: wrapProxy(dv.url)
    })),
    // ഏറ്റവും മികച്ച M4A ഓഡിയോ സ്ട്രീം (MP4Box.js-ൽ കൂട്ടിച്ചേർക്കാൻ)
    bestAudio: data.bestAudio
      ? {
          itag: data.bestAudio.itag || null,
          bitrate: data.bestAudio.bitrate || null,
          codecs: data.bestAudio.codecs || "mp4a.40.2",
          mimeType: data.bestAudio.mimeType || "audio/mp4",
          contentLength: data.bestAudio.contentLength ? Number(data.bestAudio.contentLength) : null,
          url: data.bestAudio.url,
          proxyUrl: wrapProxy(data.bestAudio.url)
        }
      : null,
    // ഫോട്ടോകൾ / കറൗസൽ ഇമേജുകൾ
    images: (data.images || []).map((img) => ({
      url: typeof img === "string" ? img : img.url,
      width: img.width || null,
      height: img.height || null,
      proxyUrl: wrapProxy(typeof img === "string" ? img : img.url)
    }))
  };
}

// ==========================================
// 4. BUILT-IN CORS STREAMING PROXY (/proxy)
// ==========================================
async function handleProxyRequest(request, targetUrl) {
  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrl);
  } catch {
    return jsonResponse({ status: "error", message: "Invalid target URL in proxy." }, 400);
  }

  const upstreamHeaders = new Headers();
  upstreamHeaders.set("User-Agent", DEFAULT_UA);
  upstreamHeaders.set("Accept", "*/*");

  // MP4Box.js-നും വീഡിയോ സീക്കിങ്ങിനും അനിവാര്യമായ Range Header കൈമാറുന്നു
  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) {
    upstreamHeaders.set("Range", rangeHeader);
  }

  // ഓരോ പ്ലാറ്റ്‌ഫോമിന്റെയും CDN ബ്ലോക്കിങ് ഒഴിവാക്കാൻ ഉചിതമായ Referer നൽകുന്നു
  if (parsedTarget.hostname.includes("instagram") || parsedTarget.hostname.includes("fbcdn")) {
    upstreamHeaders.set("Referer", "https://www.instagram.com/");
  } else if (parsedTarget.hostname.includes("twimg.com")) {
    upstreamHeaders.set("Referer", "https://x.com/");
  } else if (parsedTarget.hostname.includes("googlevideo.com")) {
    upstreamHeaders.set("Origin", "https://www.youtube.com");
    upstreamHeaders.set("Referer", "https://www.youtube.com/");
  }

  const upstreamResponse = await fetch(parsedTarget.toString(), {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    headers: upstreamHeaders,
    redirect: "follow"
  });

  const responseHeaders = new Headers(CORS_HEADERS);
  const passthroughHeaders = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "cache-control",
    "etag"
  ];

  for (const h of passthroughHeaders) {
    const val = upstreamResponse.headers.get(h);
    if (val) responseHeaders.set(h, val);
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: responseHeaders
  });
}

// ==========================================
// 5. PLATFORM EXTRACTOR MODULES
// ==========================================

/**
 * MODULE 1: YOUTUBE (InnerTube API - youtubei/v1/player)
 * Extracts 1080p/4K MP4 DASH video streams & M4A audio stream for MP4Box.js
 */
async function extractYouTube(url) {
  const videoId = parseYouTubeId(url);
  if (!videoId) throw new Error("Invalid YouTube video ID.");

  // ANDROID_VR ക്ലയന്റ് വഴി സൈഫർ ഇല്ലാത്ത നേരിട്ടുള്ള 1080p/4K സ്ട്രീമുകൾ ലഭിക്കുന്നു
  const innertubePayload = {
    videoId,
    context: {
      client: {
        clientName: "ANDROID_VR",
        clientVersion: "1.60.19",
        androidSdkVersion: 34,
        userAgent: "com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 14; en_US; Quest 3; Build/UP1A.231005.007.A1; Cronet/132.0.6808.3)",
        hl: "en",
        gl: "US",
        timeZone: "UTC",
        utcOffsetMinutes: 0
      }
    },
    contentCheckOk: true,
    racyCheckOk: true
  };

  const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": innertubePayload.context.client.userAgent,
      "X-YouTube-Client-Name": "28",
      "X-YouTube-Client-Version": "1.60.19"
    },
    body: JSON.stringify(innertubePayload)
  });

  if (!res.ok) throw new Error(`YouTube InnerTube error: ${res.status}`);
  const data = await res.json();

  if (data.playabilityStatus?.status !== "OK") {
    throw new Error(data.playabilityStatus?.reason || "YouTube video unavailable or restricted.");
  }

  const streamingData = data.streamingData || {};
  const formats = streamingData.formats || [];
  const adaptiveFormats = streamingData.adaptiveFormats || [];

  // 1. Combined Video + Audio (360p / 720p)
  const videos = formats
    .filter((f) => f.url && f.mimeType?.includes("video/mp4"))
    .map((f) => ({
      quality: f.qualityLabel || `${f.height}p`,
      width: f.width,
      height: f.height,
      mimeType: "video/mp4",
      url: f.url
    }));

  // 2. DASH MP4 Video-Only Streams (1080p, 1440p, 4K - MP4Box.js അനുയോജ്യമായവ)
  const dashVideos = adaptiveFormats
    .filter((f) => f.url && f.mimeType?.startsWith("video/mp4"))
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0))
    .map((f) => {
      const codecMatch = f.mimeType.match(/codecs="([^"]+)"/);
      return {
        itag: f.itag,
        quality: f.qualityLabel || `${f.height}p`,
        width: f.width,
        height: f.height,
        fps: f.fps || 30,
        codecs: codecMatch ? codecMatch[1] : "avc1",
        mimeType: "video/mp4",
        contentLength: f.contentLength,
        url: f.url
      };
    });

  // 3. Best M4A Audio Stream (audio/mp4)
  const m4aAudios = adaptiveFormats
    .filter((f) => f.url && f.mimeType?.startsWith("audio/mp4"))
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

  const topAudio = m4aAudios[0] || null;
  const bestAudio = topAudio
    ? {
        itag: topAudio.itag,
        bitrate: topAudio.bitrate,
        codecs: topAudio.mimeType.match(/codecs="([^"]+)"/)?.[1] || "mp4a.40.2",
        mimeType: "audio/mp4",
        contentLength: topAudio.contentLength,
        url: topAudio.url
      }
    : null;

  const thumbs = data.videoDetails?.thumbnail?.thumbnails || [];
  const bestThumb =
    thumbs.length > 0
      ? thumbs[thumbs.length - 1].url
      : `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;

  return {
    title: data.videoDetails?.title || "YouTube Video",
    thumbnail: bestThumb,
    videos,
    dashVideos,
    bestAudio,
    images: []
  };
}

function parseYouTubeId(url) {
  const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?|shorts|live)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;
  const match = url.match(regex);
  return match ? match[1] : null;
}

/**
 * MODULE 2: TWITTER / X
 * Uses Twitter Public Syndication & VX/FX fallback for Direct Original MP4 & Images
 */
async function extractTwitter(url) {
  const match = url.match(/(?:twitter\.com|x\.com)\/[^\/]+\/status\/(\d+)/i);
  if (!match) throw new Error("Invalid Twitter/X status URL.");
  const tweetId = match[1];

  // രീതി 1: Public API endpoint (api.vxtwitter.com) - Direct Twitter CDN URLs നൽകുന്നു
  const vxRes = await fetch(`https://api.vxtwitter.com/Twitter/status/${tweetId}`, {
    headers: { "User-Agent": DEFAULT_UA }
  });

  if (vxRes.ok) {
    const vxData = await vxRes.json();
    const videos = [];
    const images = [];

    for (const media of vxData.media_extended || []) {
      if (media.type === "video" || media.type === "gif") {
        videos.push({
          quality: "Original HD",
          width: media.size?.width,
          height: media.size?.height,
          mimeType: "video/mp4",
          url: media.url
        });
      } else if (media.type === "image") {
        const origImg = media.url.includes("?") ? media.url : `${media.url}?name=orig`;
        images.push({
          url: origImg,
          width: media.size?.width,
          height: media.size?.height
        });
      }
    }

    return {
      title: vxData.text ? vxData.text.slice(0, 90) : "X Post",
      thumbnail: vxData.media_extended?.[0]?.thumbnail_url || images[0]?.url || null,
      videos,
      images
    };
  }

  // രീതി 2: Twitter Official Syndication Fallback
  const token = ((Number(tweetId) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
  const synRes = await fetch(
    `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&token=${token}`,
    { headers: { "User-Agent": DEFAULT_UA } }
  );

  if (!synRes.ok) throw new Error("Unable to fetch X/Twitter media.");
  const synData = await synRes.json();

  const videos = [];
  const images = [];

  for (const media of synData.mediaDetails || []) {
    if (media.type === "video" || media.type === "animated_gif") {
      const mp4Variants = (media.video_info?.variants || [])
        .filter((v) => v.content_type === "video/mp4")
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      for (const v of mp4Variants) {
        const resMatch = v.url.match(/\/(\d+x\d+)\//);
        videos.push({
          quality: resMatch ? resMatch[1] : `${Math.round((v.bitrate || 0) / 1000)}kbps`,
          mimeType: "video/mp4",
          url: v.url
        });
      }
    } else if (media.type === "photo") {
      images.push({ url: `${media.media_url_https}?name=orig` });
    }
  }

  return {
    title: synData.text ? synData.text.slice(0, 90) : "X Post",
    thumbnail: synData.photos?.[0]?.url || synData.video?.poster || null,
    videos,
    images
  };
}

/**
 * MODULE 3: INSTAGRAM
 * Extracts Reels, Posts & Carousels via Direct GraphQL & Embed Endpoints
 */
async function extractInstagram(url) {
  const match = url.match(/instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  if (!match) throw new Error("Invalid Instagram URL. Provide a valid Post or Reel link.");
  const shortcode = match[1];

  const videos = [];
  const images = [];
  let thumbnail = null;
  let title = "Instagram Media";

  // രീതി 1: Instagram Public GraphQL Query
  const gqlParams = new URLSearchParams({
    av: "0",
    __d: "www",
    __user: "0",
    __a: "1",
    __req: "3",
    __ccg: "EXCELLENT",
    variables: JSON.stringify({
      shortcode,
      fetch_comment_count: 0,
      fetch_related_profile_media_count: 0,
      parent_comment_count: 0,
      child_comment_count: 0,
      fetch_like_count: 0,
      fetch_tagged_user_count: null,
      fetch_preview_comment_count: 0,
      has_threaded_comments: false,
      hoisted_comment_id: null,
      hoisted_reply_id: null
    }),
    doc_id: "10015901848480474"
  });

  const gqlRes = await fetch("https://www.instagram.com/api/graphql", {
    method: "POST",
    headers: {
      "User-Agent": DEFAULT_UA,
      "Content-Type": "application/x-www-form-urlencoded",
      "X-IG-App-ID": "936619743392459",
      "X-FB-LSD": "AVqbxe3J_YA",
      "X-ASBD-ID": "129477",
      "Sec-Fetch-Site": "same-origin"
    },
    body: gqlParams.toString()
  });

  if (gqlRes.ok) {
    const gqlJson = await gqlRes.json().catch(() => null);
    const media = gqlJson?.data?.xdt_shortcode_media;

    if (media) {
      title = media.edge_media_to_caption?.edges?.[0]?.node?.text?.slice(0, 90) || title;
      thumbnail = media.display_url;

      const edges = media.edge_sidecar_to_children?.edges;
      if (edges && edges.length > 0) {
        for (const edge of edges) {
          const node = edge.node;
          if (node.is_video && node.video_url) {
            videos.push({
              quality: "Original HD",
              width: node.dimensions?.width,
              height: node.dimensions?.height,
              url: node.video_url
            });
          } else if (node.display_url) {
            images.push({
              url: node.display_url,
              width: node.dimensions?.width,
              height: node.dimensions?.height
            });
          }
        }
      } else if (media.is_video && media.video_url) {
        videos.push({
          quality: "Original HD",
          width: media.dimensions?.width,
          height: media.dimensions?.height,
          url: media.video_url
        });
      } else if (media.display_url) {
        images.push({
          url: media.display_url,
          width: media.dimensions?.width,
          height: media.dimensions?.height
        });
      }

      if (videos.length > 0 || images.length > 0) {
        return { title, thumbnail, videos, images };
      }
    }
  }

  // രീതി 2: Embed Captioned Fallback
  const embedRes = await fetch(`https://www.instagram.com/p/${shortcode}/embed/captioned/`, {
    headers: { "User-Agent": DEFAULT_UA }
  });
  const html = await embedRes.text();

  const videoMatch = html.match(/"video_url":"([^"]+)"/);
  if (videoMatch) {
    videos.push({
      quality: "Original",
      url: JSON.parse(`"${videoMatch[1]}"`)
    });
  }

  const displayMatches = [...html.matchAll(/"display_url":"([^"]+)"/g)];
  for (const m of displayMatches) {
    const cleanUrl = JSON.parse(`"${m[1]}"`);
    if (!images.some((i) => i.url === cleanUrl)) {
      images.push({ url: cleanUrl });
    }
  }

  if (videos.length === 0 && images.length === 0) {
    throw new Error("Instagram media could not be extracted (Post may be private).");
  }

  return {
    title,
    thumbnail: images[0]?.url || null,
    videos,
    images: videos.length > 0 ? [] : images
  };
}

/**
 * MODULE 4: THREADS (threads.net / threads.com)
 * Parses embedded Relay JSON & OpenGraph tags for Original Video/Photo URLs
 */
async function extractThreads(url) {
  const cleanUrl = url.split("?")[0];
  const res = await fetch(cleanUrl, {
    headers: {
      "User-Agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
      Accept: "text/html,application/xhtml+xml"
    }
  });

  if (!res.ok) throw new Error(`Threads fetch failed: ${res.status}`);
  const html = await res.text();

  const videos = [];
  const images = [];

  // JSON-ൽ നിന്നുള്ള video_versions വേർതിരിക്കുന്നു
  const videoVersionMatches = [...html.matchAll(/"video_versions":\[(.*?)\]/g)];
  for (const match of videoVersionMatches) {
    const urlMatches = [...match[1].matchAll(/"url":"([^"]+)"/g)];
    if (urlMatches.length > 0) {
      const rawVideoUrl = JSON.parse(`"${urlMatches[0][1]}"`);
      if (!videos.some((v) => v.url === rawVideoUrl)) {
        videos.push({ quality: "Original HD", url: rawVideoUrl });
      }
    }
  }

  // OpenGraph Video Fallback
  const ogVideo = matchMetaContent(html, "og:video") || matchMetaContent(html, "og:video:secure_url");
  if (ogVideo && !videos.some((v) => v.url === ogVideo)) {
    videos.push({ quality: "HD", url: decodeHtmlEntities(ogVideo) });
  }

  // Images extraction
  const ogImage = matchMetaContent(html, "og:image");
  if (ogImage && videos.length === 0) {
    images.push({ url: decodeHtmlEntities(ogImage) });
  }

  const title = matchMetaContent(html, "og:title") || "Threads Post";

  if (videos.length === 0 && images.length === 0) {
    throw new Error("No media found in this Threads link.");
  }

  return {
    title: decodeHtmlEntities(title),
    thumbnail: ogImage ? decodeHtmlEntities(ogImage) : null,
    videos,
    images
  };
}

/**
 * MODULE 5: FACEBOOK
 * Resolves fb.watch / Reels / Videos & Extracts HD/SD Native Streams
 */
async function extractFacebook(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Sec-Fetch-Mode": "navigate"
    },
    redirect: "follow"
  });

  if (!res.ok) throw new Error(`Facebook fetch error: ${res.status}`);
  const html = await res.text();

  const videos = [];
  const images = [];

  const hdPatterns = [
    /"browser_native_hd_url":"([^"]+)"/,
    /"hd_src":"([^"]+)"/,
    /"hd_src_no_ratelimit":"([^"]+)"/,
    /"playable_url_quality_hd":"([^"]+)"/
  ];

  const sdPatterns = [
    /"browser_native_sd_url":"([^"]+)"/,
    /"sd_src":"([^"]+)"/,
    /"sd_src_no_ratelimit":"([^"]+)"/,
    /"playable_url":"([^"]+)"/
  ];

  for (const pattern of hdPatterns) {
    const m = html.match(pattern);
    if (m && m[1] !== "null") {
      videos.push({ quality: "HD", url: cleanJsonEscapedUrl(m[1]) });
      break;
    }
  }

  for (const pattern of sdPatterns) {
    const m = html.match(pattern);
    if (m && m[1] !== "null") {
      videos.push({ quality: "SD", url: cleanJsonEscapedUrl(m[1]) });
      break;
    }
  }

  const ogVideo = matchMetaContent(html, "og:video") || matchMetaContent(html, "og:video:url");
  if (ogVideo && videos.length === 0) {
    videos.push({ quality: "Standard", url: decodeHtmlEntities(ogVideo) });
  }

  const ogImage = matchMetaContent(html, "og:image");
  if (ogImage && videos.length === 0) {
    images.push({ url: decodeHtmlEntities(ogImage) });
  }

  if (videos.length === 0 && images.length === 0) {
    throw new Error("Could not extract Facebook media. Ensure the post is public.");
  }

  return {
    title: decodeHtmlEntities(matchMetaContent(html, "og:title") || "Facebook Media"),
    thumbnail: ogImage ? decodeHtmlEntities(ogImage) : null,
    videos,
    images
  };
}

/**
 * MODULE 6: SNAPCHAT
 * Extracts Spotlight & Public Story Videos/Images via __NEXT_DATA__
 */
async function extractSnapchat(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": DEFAULT_UA,
      Accept: "text/html,application/xhtml+xml"
    },
    redirect: "follow"
  });

  if (!res.ok) throw new Error(`Snapchat fetch error: ${res.status}`);
  const html = await res.text();

  const videos = [];
  const images = [];
  let thumbnail = matchMetaContent(html, "og:image");
  let title = matchMetaContent(html, "og:title") || "Snapchat Media";

  // __NEXT_DATA__ JSON പേലോഡ് പരിശോധിക്കുന്നു
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (nextDataMatch) {
    try {
      const nextJson = JSON.parse(nextDataMatch[1]);
      const pageProps = nextJson?.props?.pageProps || {};

      // Spotlight & Story Media URLs കണ്ടെത്തുന്നു
      const jsonStr = JSON.stringify(pageProps);
      const mp4Matches = [...jsonStr.matchAll(/"(https:\/\/[^"]+\.sc-cdn\.net\/[^"]+)"/g)];

      for (const m of mp4Matches) {
        const candidateUrl = m[1];
        if (/video|\.mp4|\.(?:m3u8)/i.test(candidateUrl) || candidateUrl.includes("/d/")) {
          if (!videos.some((v) => v.url === candidateUrl)) {
            videos.push({ quality: "Original HD", url: candidateUrl });
          }
        }
      }

      const snapMediaUrl =
        pageProps?.curatedHighlights?.[0]?.snapList?.[0]?.snapUrls?.mediaUrl ||
        pageProps?.story?.snapList?.[0]?.snapUrls?.mediaUrl ||
        pageProps?.spotlightFeed?.spotlightStories?.[0]?.snapList?.[0]?.snapUrls?.mediaUrl;

      if (snapMediaUrl && !videos.some((v) => v.url === snapMediaUrl)) {
        videos.unshift({ quality: "Original HD", url: snapMediaUrl });
      }
    } catch {
      // Fallback to meta tags below
    }
  }

  const ogVideo = matchMetaContent(html, "og:video") || matchMetaContent(html, "og:video:secure_url");
  if (ogVideo && !videos.some((v) => v.url === ogVideo)) {
    videos.push({ quality: "HD", url: decodeHtmlEntities(ogVideo) });
  }

  if (videos.length === 0 && thumbnail) {
    images.push({ url: decodeHtmlEntities(thumbnail) });
  }

  if (videos.length === 0 && images.length === 0) {
    throw new Error("No public Snapchat media found at this URL.");
  }

  return {
    title: decodeHtmlEntities(title),
    thumbnail: thumbnail ? decodeHtmlEntities(thumbnail) : null,
    videos,
    images
  };
}

// ==========================================
// 6. HELPER UTILITIES
// ==========================================
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS
    }
  });
}

function matchMetaContent(html, property) {
  const regex1 = new RegExp(`<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["']`, "i");
  const regex2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["']`, "i");
  return html.match(regex1)?.[1] || html.match(regex2)?.[1] || null;
}

function cleanJsonEscapedUrl(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw.replace(/\\\//g, "/").replace(/\\u0025/g, "%").replace(/\\u0026/g, "&");
  }
}

function decodeHtmlEntities(str) {
  if (!str) return "";
  return str
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
