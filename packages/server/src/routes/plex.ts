import { Router, Request, Response } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import { sessionsTable } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { getInstance } from "../discord.js";
import { getPlexUrl } from "../services/plex.js";

const router = Router();

const DEBUG = process.env.NODE_ENV === "development";

const OUR_CLIENT_ID = "PlexDiscordTheater";

const plexFetch = async (
  path: string,
  params?: Record<string, string>,
  headers?: Record<string, string>,
) => {
  const { url, token } = getPlexUrl();
  const urlObj = new URL(path, url);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      urlObj.searchParams.set(key, value);
    });
  }
  urlObj.searchParams.set("X-Plex-Token", token);

  const res = await fetch(urlObj.toString(), {
    headers: {
      Accept: "application/json",
      "X-Plex-Client-Identifier": OUR_CLIENT_ID,
      "X-Plex-Product": "Plex Discord Theater",
      "X-Plex-Version": "1.0",
      "X-Plex-Platform": "Chrome",
      "X-Plex-Device": "Browser",
      "X-Plex-Device-Name": "Plex Discord Theater",
      "X-Plex-Model": "Web",
      "X-Plex-Language": "en",
      ...headers,
    },
  });

  return res;
};

const plexJSON = async <T = any>(
  path: string,
  params?: Record<string, string>,
  headers?: Record<string, string>,
): Promise<T> => {
  const res = await plexFetch(path, params, headers);
  if (!res.ok) {
    throw new Error(`Plex request failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
};

const plexText = async (
  path: string,
  params?: Record<string, string>,
  headers?: Record<string, string>,
): Promise<string> => {
  const res = await plexFetch(path, params, headers);
  if (!res.ok) {
    throw new Error(`Plex request failed: ${res.status} ${res.statusText}`);
  }
  return res.text();
};

interface PlexStream {
  id: number;
  streamType: number;
  codec?: string;
  language?: string;
  languageCode?: string;
  selected?: boolean;
  title?: string;
  displayTitle?: string;
  extendedDisplayTitle?: string;
}

interface PlexPart {
  id: number;
  container?: string;
  Stream?: PlexStream[];
}

interface PlexMedia {
  container?: string;
  videoResolution?: string;
  Part?: PlexPart[];
}

interface PlexMetadataItem {
  ratingKey: string;
  title: string;
  type: string;
  thumb?: string;
  art?: string;
  summary?: string;
  year?: number;
  duration?: number;
  Media?: PlexMedia[];
  Guid?: { id: string }[];
  titleSort?: string;
  index?: number;
  parentRatingKey?: string;
  grandparentRatingKey?: string;
  parentTitle?: string;
  grandparentTitle?: string;
  season?: number;
  episode?: number;
  leafCount?: number;
  viewedLeafCount?: number;
  childCount?: number;
  Genre?: { tag: string }[];
  Role?: { tag: string }[];
  Director?: { tag: string }[];
  Writer?: { tag: string }[];
  studio?: string;
  contentRating?: string;
  rating?: number;
  audienceRating?: number;
  originallyAvailableAt?: string;
}

interface MediaStreamInfo {
  videoCodec?: string;
  audioCodec?: string;
  container?: string;
  videoResolution?: string;
}

async function getMediaStreamInfo(ratingKey: string): Promise<MediaStreamInfo | null> {
  try {
    const data = await plexJSON<{ MediaContainer: { Metadata?: PlexMetadataItem[] } }>(
      `/library/metadata/${ratingKey}`,
    );
    const metadata = data.MediaContainer.Metadata?.[0];
    if (!metadata) return null;

    const media = metadata.Media?.[0];
    const part = media?.Part?.[0];
    const streams = part?.Stream || [];

    const videoStream = streams.find((s) => s.streamType === 1);
    const audioStream = streams.find((s) => s.streamType === 2);

    return {
      videoCodec: videoStream?.codec?.toLowerCase(),
      audioCodec: audioStream?.codec?.toLowerCase(),
      container: part?.container?.toLowerCase() || media?.container?.toLowerCase() || "",
      videoResolution: media?.videoResolution,
    };
  } catch (err) {
    console.error("[HLS] Failed to inspect media streams:", err);
    return null;
  }
}

function getBestSubtitleStream(part: PlexPart, preferredLanguage?: string): PlexStream | null {
  const streams = part.Stream?.filter((s) => s.streamType === 3) || [];

  if (streams.length === 0) return null;

  // Prefer selected stream if any
  const selected = streams.find((s) => s.selected);
  if (selected) return selected;

  // Prefer external subtitles
  const external = streams.find((s) => s.title?.toLowerCase().includes("external"));
  if (external) return external;

  // Prefer language match
  if (preferredLanguage) {
    const langMatch = streams.find(
      (s) =>
        s.languageCode?.toLowerCase() === preferredLanguage.toLowerCase() ||
        s.language?.toLowerCase().includes(preferredLanguage.toLowerCase()),
    );
    if (langMatch) return langMatch;
  }

  // Default to first
  return streams[0];
}

function getSubtitleMode(
  part: PlexPart,
  selectedSubtitleStreamId?: number,
): "burn" | "sidecar" | "none" {
  const streams = part.Stream?.filter((s) => s.streamType === 3) || [];
  if (streams.length === 0) return "none";

  if (selectedSubtitleStreamId !== undefined) {
    const selected = streams.find((s) => s.id === selectedSubtitleStreamId);
    if (selected) {
      return selected.title?.toLowerCase().includes("external") ? "sidecar" : "burn";
    }
  }

  return "none";
}

// GET /api/plex/libraries
router.get("/libraries", async (_req: Request, res: Response) => {
  try {
    const data = await plexJSON<{
      MediaContainer: {
        Directory?: Array<{
          key: string;
          title: string;
          type: string;
          thumb?: string;
        }>;
      };
    }>("/library/sections");

    const libraries =
      data.MediaContainer.Directory?.map((lib) => ({
        key: lib.key,
        title: lib.title,
        type: lib.type,
        thumb: lib.thumb,
      })) || [];

    res.json({ libraries });
  } catch (err) {
    console.error("Error fetching libraries:", err);
    res.status(500).json({ error: "Failed to fetch libraries" });
  }
});

// GET /api/plex/library/:key/items
router.get("/library/:key/items", async (req: Request, res: Response) => {
  try {
    const key = req.params.key;
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 50;
    const sort = (req.query.sort as string) || "titleSort";
    const sortDirection = (req.query.sortDirection as string) || "asc";

    const start = (page - 1) * pageSize;

    const data = await plexJSON<{
      MediaContainer: {
        Metadata?: PlexMetadataItem[];
        totalSize?: number;
        size?: number;
      };
    }>(`/library/sections/${key}/all`, {
      "X-Plex-Container-Start": start.toString(),
      "X-Plex-Container-Size": pageSize.toString(),
      sort: `${sort}:${sortDirection}`,
    });

    const items =
      data.MediaContainer.Metadata?.map((item) => ({
        ratingKey: item.ratingKey,
        title: item.title,
        type: item.type,
        thumb: item.thumb,
        duration: item.duration,
        year: item.year,
      })) || [];

    res.json({
      items,
      totalSize: data.MediaContainer.totalSize || data.MediaContainer.size || items.length,
      page,
      pageSize,
    });
  } catch (err) {
    console.error("Error fetching library items:", err);
    res.status(500).json({ error: "Failed to fetch library items" });
  }
});

// GET /api/plex/metadata/:ratingKey
router.get("/metadata/:ratingKey", async (req: Request, res: Response) => {
  try {
    const ratingKey = req.params.ratingKey;
    const data = await plexJSON<{ MediaContainer: { Metadata?: PlexMetadataItem[] } }>(
      `/library/metadata/${ratingKey}`,
    );

    const metadata = data.MediaContainer.Metadata?.[0];
    if (!metadata) {
      return res.status(404).json({ error: "Metadata not found" });
    }

    const media = metadata.Media?.[0];
    const part = media?.Part?.[0];
    const streams = part?.Stream || [];

    const videoStream = streams.find((s) => s.streamType === 1);
    const audioStreams = streams.filter((s) => s.streamType === 2);
    const subtitleStreams = streams.filter((s) => s.streamType === 3);

    const response: any = {
      ratingKey: metadata.ratingKey,
      title: metadata.title,
      type: metadata.type,
      summary: metadata.summary,
      year: metadata.year,
      duration: metadata.duration,
      thumb: metadata.thumb,
      art: metadata.art,
      studio: metadata.studio,
      contentRating: metadata.contentRating,
      rating: metadata.rating,
      audienceRating: metadata.audienceRating,
      originallyAvailableAt: metadata.originallyAvailableAt,
      genre: metadata.Genre?.map((g) => g.tag) || [],
      cast: metadata.Role?.map((r) => r.tag) || [],
      director: metadata.Director?.map((d) => d.tag) || [],
      writer: metadata.Writer?.map((w) => w.tag) || [],
      media: {
        container: media?.container,
        videoResolution: media?.videoResolution,
        videoCodec: videoStream?.codec,
        audioCodec: audioStreams[0]?.codec,
        audioStreams: audioStreams.map((s) => ({
          id: s.id,
          codec: s.codec,
          language: s.language,
          languageCode: s.languageCode,
          title: s.title,
          displayTitle: s.displayTitle,
          extendedDisplayTitle: s.extendedDisplayTitle,
          selected: s.selected,
        })),
        subtitleStreams: subtitleStreams.map((s) => ({
          id: s.id,
          language: s.language,
          languageCode: s.languageCode,
          title: s.title,
          displayTitle: s.displayTitle,
          extendedDisplayTitle: s.extendedDisplayTitle,
          selected: s.selected,
        })),
      },
    };

    if (metadata.type === "episode") {
      response.seriesTitle = metadata.grandparentTitle;
      response.season = metadata.parentTitle;
      response.episodeNumber = metadata.index;
      response.seasonNumber = metadata.season;
    }

    res.json(response);
  } catch (err) {
    console.error("Error fetching metadata:", err);
    res.status(500).json({ error: "Failed to fetch metadata" });
  }
});

// GET /api/plex/thumb/:ratingKey
router.get("/thumb/:ratingKey", async (req: Request, res: Response) => {
  try {
    const ratingKey = req.params.ratingKey;
    const data = await plexJSON<{ MediaContainer: { Metadata?: PlexMetadataItem[] } }>(
      `/library/metadata/${ratingKey}`,
    );

    const metadata = data.MediaContainer.Metadata?.[0];
    if (!metadata?.thumb) {
      return res.status(404).json({ error: "No thumb available" });
    }

    const thumbRes = await plexFetch(metadata.thumb);
    if (!thumbRes.ok) {
      return res.status(thumbRes.status).json({ error: "Failed to fetch thumb" });
    }

    const contentType = thumbRes.headers.get("content-type") || "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    const buffer = await thumbRes.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("Error fetching thumb:", err);
    res.status(500).json({ error: "Failed to fetch thumb" });
  }
});

// GET /api/plex/art/:ratingKey
router.get("/art/:ratingKey", async (req: Request, res: Response) => {
  try {
    const ratingKey = req.params.ratingKey;
    const data = await plexJSON<{ MediaContainer: { Metadata?: PlexMetadataItem[] } }>(
      `/library/metadata/${ratingKey}`,
    );

    const metadata = data.MediaContainer.Metadata?.[0];
    if (!metadata?.art) {
      return res.status(404).json({ error: "No art available" });
    }

    const artRes = await plexFetch(metadata.art);
    if (!artRes.ok) {
      return res.status(artRes.status).json({ error: "Failed to fetch art" });
    }

    const contentType = artRes.headers.get("content-type") || "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    const buffer = await artRes.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("Error fetching art:", err);
    res.status(500).json({ error: "Failed to fetch art" });
  }
});

// GET /api/plex/search
router.get("/search", async (req: Request, res: Response) => {
  try {
    const query = req.query.q as string;
    if (!query) {
      return res.status(400).json({ error: "Query parameter required" });
    }

    const data = await plexJSON<{
      MediaContainer: {
        Metadata?: PlexMetadataItem[];
      };
    }>(`/hubs/search`, {
      query,
      limit: "20",
    });

    const items =
      data.MediaContainer.Metadata?.map((item) => ({
        ratingKey: item.ratingKey,
        title: item.title,
        type: item.type,
        thumb: item.thumb,
        year: item.year,
      })) || [];

    res.json({ items });
  } catch (err) {
    console.error("Error searching:", err);
    res.status(500).json({ error: "Failed to search" });
  }
});

// GET /api/plex/children/:ratingKey
router.get("/children/:ratingKey", async (req: Request, res: Response) => {
  try {
    const ratingKey = req.params.ratingKey;
    const data = await plexJSON<{
      MediaContainer: {
        Metadata?: PlexMetadataItem[];
        size?: number;
        totalSize?: number;
      };
    }>(`/library/metadata/${ratingKey}/children`);

    const items =
      data.MediaContainer.Metadata?.map((item) => ({
        ratingKey: item.ratingKey,
        title: item.title,
        type: item.type,
        thumb: item.thumb,
        duration: item.duration,
        index: item.index,
        year: item.year,
        leafCount: item.leafCount,
        viewedLeafCount: item.viewedLeafCount,
        childCount: item.childCount,
      })) || [];

    res.json({
      items,
      totalSize: data.MediaContainer.totalSize || data.MediaContainer.size || items.length,
    });
  } catch (err) {
    console.error("Error fetching children:", err);
    res.status(500).json({ error: "Failed to fetch children" });
  }
});

// GET /api/plex/continue-watching
router.get("/continue-watching", async (_req: Request, res: Response) => {
  try {
    const data = await plexJSON<{
      MediaContainer: {
        Metadata?: PlexMetadataItem[];
      };
    }>("/hubs/continueWatching/items");

    const items =
      data.MediaContainer.Metadata?.map((item) => ({
        ratingKey: item.ratingKey,
        title: item.title,
        type: item.type,
        thumb: item.thumb,
        duration: item.duration,
      })) || [];

    res.json({ items });
  } catch (err) {
    console.error("Error fetching continue watching:", err);
    res.status(500).json({ error: "Failed to fetch continue watching" });
  }
});

// GET /api/plex/recently-added
router.get("/recently-added", async (_req: Request, res: Response) => {
  try {
    const data = await plexJSON<{
      MediaContainer: {
        Metadata?: PlexMetadataItem[];
      };
    }>("/library/recentlyAdded");

    const items =
      data.MediaContainer.Metadata?.map((item) => ({
        ratingKey: item.ratingKey,
        title: item.title,
        type: item.type,
        thumb: item.thumb,
        year: item.year,
      })) || [];

    res.json({ items });
  } catch (err) {
    console.error("Error fetching recently added:", err);
    res.status(500).json({ error: "Failed to fetch recently added" });
  }
});

// GET /api/plex/hub/:hubIdentifier
router.get("/hub/:hubIdentifier", async (req: Request, res: Response) => {
  try {
    const hubIdentifier = req.params.hubIdentifier;
    const data = await plexJSON<{
      MediaContainer: {
        Metadata?: PlexMetadataItem[];
      };
    }>(`/hubs/sections/${hubIdentifier}/items`);

    const items =
      data.MediaContainer.Metadata?.map((item) => ({
        ratingKey: item.ratingKey,
        title: item.title,
        type: item.type,
        thumb: item.thumb,
        year: item.year,
      })) || [];

    res.json({ items });
  } catch (err) {
    console.error("Error fetching hub:", err);
    res.status(500).json({ error: "Failed to fetch hub" });
  }
});

// GET /api/plex/hubs
router.get("/hubs", async (_req: Request, res: Response) => {
  try {
    const data = await plexJSON<{
      MediaContainer: {
        Hub?: Array<{
          key: string;
          title: string;
          type: string;
          identifier: string;
          size: number;
        }>;
      };
    }>("/hubs/promoted");

    const hubs =
      data.MediaContainer.Hub?.map((hub) => ({
        key: hub.key,
        title: hub.title,
        type: hub.type,
        identifier: hub.identifier,
        size: hub.size,
      })) || [];

    res.json({ hubs });
  } catch (err) {
    console.error("Error fetching hubs:", err);
    res.status(500).json({ error: "Failed to fetch hubs" });
  }
});

// GET /api/plex/hub/items/:identifier
router.get("/hub/items/:identifier", async (req: Request, res: Response) => {
  try {
    const identifier = req.params.identifier;
    const data = await plexJSON<{
      MediaContainer: {
        Metadata?: PlexMetadataItem[];
      };
    }>(`/hubs/sections/${identifier}/items`);

    const items =
      data.MediaContainer.Metadata?.map((item) => ({
        ratingKey: item.ratingKey,
        title: item.title,
        type: item.type,
        thumb: item.thumb,
        year: item.year,
      })) || [];

    res.json({ items });
  } catch (err) {
    console.error("Error fetching hub items:", err);
    res.status(500).json({ error: "Failed to fetch hub items" });
  }
});

// GET /api/plex/subtitle/:ratingKey/:streamId.vtt
router.get("/subtitle/:ratingKey/:streamId.vtt", async (req: Request, res: Response) => {
  try {
    const { ratingKey, streamId } = req.params;
    const data = await plexJSON<{ MediaContainer: { Metadata?: PlexMetadataItem[] } }>(
      `/library/metadata/${ratingKey}`,
    );

    const metadata = data.MediaContainer.Metadata?.[0];
    const part = metadata?.Media?.[0]?.Part?.[0];
    if (!part) {
      return res.status(404).json({ error: "Part not found" });
    }

    const subtitleStream = part.Stream?.find(
      (s) => s.streamType === 3 && s.id.toString() === streamId,
    );
    if (!subtitleStream) {
      return res.status(404).json({ error: "Subtitle stream not found" });
    }

    // Fetch subtitle file from Plex
    const subtitleRes = await plexFetch(`/library/streams/${streamId}`);
    if (!subtitleRes.ok) {
      return res.status(subtitleRes.status).json({ error: "Failed to fetch subtitle" });
    }

    const contentType = subtitleRes.headers.get("content-type") || "text/vtt";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    const buffer = await subtitleRes.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("Error fetching subtitle:", err);
    res.status(500).json({ error: "Failed to fetch subtitle" });
  }
});

// GET /api/plex/hls/:ratingKey/master.m3u8
router.get("/hls/:ratingKey/master.m3u8", async (req: Request, res: Response) => {
  try {
    const ratingKey = req.params.ratingKey;
    const sessionId = (req.query.sessionId as string) || crypto.randomUUID();
    const offset = req.query.offset as string | undefined;
    const audioStreamId = req.query.audioStreamId as string | undefined;
    const subtitleStreamId = req.query.subtitleStreamId as string | undefined;

    console.log("[HLS] Master manifest requested for ratingKey:", ratingKey, "session:", sessionId);

    const flushStaleTranscodes = async () => {
      try {
        const { url } = getPlexUrl();
        const token = new URL(url).searchParams.get("X-Plex-Token") || "";
        const sessionsRes = await fetch(
          `${url}/video/:/transcode/sessions?X-Plex-Token=${token}`,
        );
        if (!sessionsRes.ok) return 0;
        const sessionsXml = await sessionsRes.text();
        const parser = new (await import("fast-xml-parser")).XMLParser();
        const sessions = parser.parse(sessionsXml);
        const transcodes = sessions.MediaContainer?.TranscodeSession || [];
        const toFlush = Array.isArray(transcodes) ? transcodes : [transcodes].filter(Boolean);
        let flushed = 0;
        for (const session of toFlush) {
          if (session?.key) {
            await fetch(`${url}${session.key}/stop?X-Plex-Token=${token}`, { method: "GET" });
            flushed++;
          }
        }
        return flushed;
      } catch (err) {
        console.error("[HLS] Failed to flush transcodes:", err);
        return 0;
      }
    };

    const fetchManifest = async (forceTranscode = false): Promise<string> => {
      // Inspect source media to decide whether we can avoid video transcoding
      const streamInfo = await getMediaStreamInfo(ratingKey);
      const isH264 = streamInfo?.videoCodec === "h264";
      const isDirectContainer = ["mp4", "mov", "m4v", "mkv"].includes(streamInfo?.container || "");

      // Only allow direct play/stream when:
      // - video is H.264 (browsers can't decode H.265/HEVC)
      // - container is something Plex can remux to HLS
      // If audio is not browser-native, Plex will direct-stream video and transcode audio.
      const allowDirect = !forceTranscode && isH264 && isDirectContainer;

      const params: Record<string, string> = {
        hasMDE: "1",
        path: `/library/metadata/${ratingKey}`,
        mediaIndex: "0",
        partIndex: "0",
        protocol: "hls",
        fastSeek: "1",
        directPlay: allowDirect ? "1" : "0",
        directStream: allowDirect ? "1" : "0",
        directStreamAudio: "1",
        videoResolution: "1920x1080",
        videoBitrate: "20000",
        peakBitrate: "20000",
        videoQuality: "99",
        autoAdjustQuality: "0",
        location: "lan",
        mediaBufferSize: "102400",
        secondsPerSegment: "3",
        subtitles: "burn",
      };
      if (offset) params.offset = offset;

      if (audioStreamId) {
        params.audioStreamID = audioStreamId;
      }

      // Build a client profile that declares H.264 direct-play support when appropriate
      const baseProfile =
        "add-transcode-target(type=videoProfile&context=streaming&protocol=hls&container=mpegts&videoCodec=h264&audioCodec=aac)";

      const directPlayProfiles = allowDirect
        ? "&add-direct-play-profile(type=videoProfile&container=mp4&videoCodec=h264&audioCodec=aac,mp3)" +
          "&add-direct-play-profile(type=videoProfile&container=mov&videoCodec=h264&audioCodec=aac,mp3)" +
          "&add-direct-play-profile(type=videoProfile&container=m4v&videoCodec=h264&audioCodec=aac,mp3)" +
          "&add-direct-play-profile(type=videoProfile&container=mkv&videoCodec=h264&audioCodec=aac,mp3)" +
          "&add-direct-stream-profile(type=videoProfile&container=mkv&videoCodec=h264&audioCodec=aac,ac3,eac3,mp3)" +
          "&add-direct-stream-profile(type=videoProfile&container=mp4&videoCodec=h264&audioCodec=aac,ac3,eac3,mp3)"
        : "";

      const hlsHeaders = {
        "X-Plex-Session-Identifier": sessionId,
        "X-Plex-Client-Profile-Extra": baseProfile + directPlayProfiles,
        "X-Plex-Client-Identifier": OUR_CLIENT_ID,
        "X-Plex-Product": "Plex Discord Theater",
        "X-Plex-Platform": "Chrome",
        "X-Plex-Device": "Browser",
      };

      if (DEBUG) {
        console.log(
          "[HLS] Stream decision:",
          allowDirect ? "direct-stream" : "transcode",
          "videoCodec:",
          streamInfo?.videoCodec,
          "audioCodec:",
          streamInfo?.audioCodec,
          "container:",
          streamInfo?.container,
        );
      }

      const decisionPath = "/video/:/transcode/universal/decision";
      const hlsPath = "/video/:/transcode/universal/start.m3u8";

      let decisionRes = await plexFetch(decisionPath, params, hlsHeaders);
      if (!decisionRes.ok) {
        throw new Error(`Decision request failed: ${decisionRes.status}`);
      }
      console.log("[HLS] Decision:", decisionRes.status, "code:", undefined, undefined);

      // Add subtitle stream ID after decision
      const startParams = { ...params };
      if (subtitleStreamId) {
        startParams.subtitleStreamID = subtitleStreamId;
        startParams.subtitles = "burn";
      }

      let plexRes = await plexFetch(hlsPath, startParams, hlsHeaders);
      console.log("[HLS] Start returned", plexRes.status);

      if (plexRes.status === 400) {
        console.log("[HLS] Start returned 400, flushing stale transcodes...");
        let flushed = await flushStaleTranscodes();
        console.log("[HLS] Flushed", flushed, "stale transcode(s)");

        for (let attempt = 1; attempt <= 3 && plexRes.status === 400; attempt++) {
          // On first retry, if we tried direct play/stream, fall back to forced transcode
          if (attempt === 1 && allowDirect) {
            console.log("[HLS] Direct stream failed, falling back to forced transcode");
            return fetchManifest(true);
          }

          const delay = flushed > 0 ? 3000 + attempt * 1500 : 2000 * attempt;
          console.log("[HLS] Retry", attempt, "in", delay, "ms");
          await new Promise((r) => setTimeout(r, delay));
          if (attempt === 2 && plexRes.status === 400) {
            const reflushed = await flushStaleTranscodes();
            if (reflushed > 0) {
              flushed += reflushed;
              console.log("[HLS] Re-flushed", reflushed, "more transcode(s)");
              await new Promise((r) => setTimeout(r, 3000));
            }
          }
          // Re-prime decision before retry
          try {
            const retryDecision = await plexFetch(
              decisionPath,
              { ...params, transcodeSessionId: sessionId },
              hlsHeaders,
            );
            console.log("[HLS] Retry decision:", retryDecision.status);
          } catch {}
          plexRes = await plexFetch(hlsPath, startParams, hlsHeaders);
          console.log("[HLS] Retry", attempt, "result:", plexRes.status);
        }
      }

      if (!plexRes.ok) {
        const errorText = await plexRes.text();
        console.error("HLS start error:", plexRes.status, errorText);
        throw new Error(`Plex returned ${plexRes.status}`);
      }

      const manifest = await plexRes.text();
      return manifest;
    };

    const manifest = await fetchManifest();
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache");
    res.send(manifest);
  } catch (err) {
    console.error("HLS master manifest error:", err);
    res.status(500).json({ error: "Failed to generate HLS manifest" });
  }
});

// GET /api/plex/hls/:ratingKey/segment
router.get("/hls/:ratingKey/segment", async (req: Request, res: Response) => {
  try {
    const ratingKey = req.params.ratingKey;
    const sessionId = (req.query.sessionId as string) || "";
    const path = req.query.path as string;

    if (!path) {
      return res.status(400).json({ error: "Segment path required" });
    }

    const segmentRes = await plexFetch(path, { sessionId });
    if (!segmentRes.ok) {
      return res.status(segmentRes.status).json({ error: "Failed to fetch segment" });
    }

    const contentType = segmentRes.headers.get("content-type") || "video/MP2T";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-cache");
    const buffer = await segmentRes.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("Error fetching segment:", err);
    res.status(500).json({ error: "Failed to fetch segment" });
  }
});

// GET /api/plex/status
router.get("/status", async (_req: Request, res: Response) => {
  try {
    const data = await plexJSON<{ MediaContainer: { version: string } }>("/");
    res.json({
      connected: true,
      plexVersion: data.MediaContainer.version,
    });
  } catch (err) {
    console.error("Error checking Plex status:", err);
    res.status(500).json({ connected: false, error: "Failed to connect to Plex" });
  }
});

// GET /api/plex/sessions
router.get("/sessions", async (_req: Request, res: Response) => {
  try {
    const data = await plexJSON<{
      MediaContainer: {
        Metadata?: PlexMetadataItem[];
      };
    }>("/status/sessions");

    const sessions =
      data.MediaContainer.Metadata?.map((item) => ({
        ratingKey: item.ratingKey,
        title: item.title,
        type: item.type,
        thumb: item.thumb,
        duration: item.duration,
      })) || [];

    res.json({ sessions });
  } catch (err) {
    console.error("Error fetching sessions:", err);
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
});

// GET /api/plex/timeline
router.get("/timeline/:ratingKey", async (req: Request, res: Response) => {
  try {
    const ratingKey = req.params.ratingKey;
    const data = await plexJSON<{
      MediaContainer: {
        Metadata?: PlexMetadataItem[];
      };
    }>(`/library/metadata/${ratingKey}`, {
      includeConcerts: "1",
      includeExtras: "1",
      includeOnDeck: "1",
      includePopularLeaves: "1",
      includePreferences: "1",
      includeReviews: "1",
      includeChapters: "1",
      includeStations: "1",
      includeExternalMedia: "1",
      asyncAugmentLoading: "1",
      asyncCheckFiles: "1",
      asyncRefreshAnalysis: "1",
      asyncRefreshLocalMediaAgent: "1",
    });

    const metadata = data.MediaContainer.Metadata?.[0];
    if (!metadata) {
      return res.status(404).json({ error: "Metadata not found" });
    }

    res.json({
      ratingKey: metadata.ratingKey,
      title: metadata.title,
      type: metadata.type,
      duration: metadata.duration,
    });
  } catch (err) {
    console.error("Error fetching timeline:", err);
    res.status(500).json({ error: "Failed to fetch timeline" });
  }
});

// GET /api/plex/watchlist
router.get("/watchlist", async (_req: Request, res: Response) => {
  try {
    const data = await plexJSON<{
      MediaContainer: {
        Metadata?: PlexMetadataItem[];
      };
    }>("/library/sections/watchlist/items");

    const items =
      data.MediaContainer.Metadata?.map((item) => ({
        ratingKey: item.ratingKey,
        title: item.title,
        type: item.type,
        thumb: item.thumb,
        year: item.year,
      })) || [];

    res.json({ items });
  } catch (err) {
    console.error("Error fetching watchlist:", err);
    res.status(500).json({ error: "Failed to fetch watchlist" });
  }
});

// GET /api/plex/collections
router.get("/collections", async (_req: Request, res: Response) => {
  try {
    const data = await plexJSON<{
      MediaContainer: {
        Metadata?: PlexMetadataItem[];
      };
    }>("/library/sections/all/collections");

    const items =
      data.MediaContainer.Metadata?.map((item) => ({
        ratingKey: item.ratingKey,
        title: item.title,
        type: item.type,
        thumb: item.thumb,
      })) || [];

    res.json({ items });
  } catch (err) {
    console.error("Error fetching collections:", err);
    res.status(500).json({ error: "Failed to fetch collections" });
  }
});

// GET /api/plex/collection/:ratingKey/items
router.get("/collection/:ratingKey/items", async (req: Request, res: Response) => {
  try {
    const ratingKey = req.params.ratingKey;
    const data = await plexJSON<{
      MediaContainer: {
        Metadata?: PlexMetadataItem[];
      };
    }>(`/library/metadata/${ratingKey}/children`);

    const items =
      data.MediaContainer.Metadata?.map((item) => ({
        ratingKey: item.ratingKey,
        title: item.title,
        type: item.type,
        thumb: item.thumb,
        year: item.year,
      })) || [];

    res.json({ items });
  } catch (err) {
    console.error("Error fetching collection items:", err);
    res.status(500).json({ error: "Failed to fetch collection items" });
  }
});

// GET /api/plex/servers
router.get("/servers", async (_req: Request, res: Response) => {
  try {
    const data = await plexJSON<{
      MediaContainer: {
        Server?: Array<{
          name: string;
          address: string;
          port: number;
          version: string;
          scheme: string;
        }>;
      };
    }>("/resources?includeHttps=1");

    const servers =
      data.MediaContainer.Server?.map((server) => ({
        name: server.name,
        address: server.address,
        port: server.port,
        version: server.version,
        scheme: server.scheme,
      })) || [];

    res.json({ servers });
  } catch (err) {
    console.error("Error fetching servers:", err);
    res.status(500).json({ error: "Failed to fetch servers" });
  }
});

// GET /api/plex/playlists
router.get("/playlists", async (_req: Request, res: Response) => {
  try {
    const data = await plexJSON<{
      MediaContainer: {
        Metadata?: PlexMetadataItem[];
      };
    }>("/playlists");

    const items =
      data.MediaContainer.Metadata?.map((item) => ({
        ratingKey: item.ratingKey,
        title: item.title,
        type: item.type,
        thumb: item.thumb,
      })) || [];

    res.json({ items });
  } catch (err) {
    console.error("Error fetching playlists:", err);
    res.status(500).json({ error: "Failed to fetch playlists" });
  }
});

// GET /api/plex/playlist/:ratingKey/items
router.get("/playlist/:ratingKey/items", async (req: Request, res: Response) => {
  try {
    const ratingKey = req.params.ratingKey;
    const data = await plexJSON<{
      MediaContainer: {
        Metadata?: PlexMetadataItem[];
      };
    }>(`/playlists/${ratingKey}/items`);

    const items =
      data.MediaContainer.Metadata?.map((item) => ({
        ratingKey: item.ratingKey,
        title: item.title,
        type: item.type,
        thumb: item.thumb,
        year: item.year,
      })) || [];

    res.json({ items });
  } catch (err) {
    console.error("Error fetching playlist items:", err);
    res.status(500).json({ error: "Failed to fetch playlist items" });
  }
});

// GET /api/plex/on-deck
router.get("/on-deck", async (_req: Request, res: Response) => {
  try {
    const data = await plexJSON<{
      MediaContainer: {
        Metadata?: PlexMetadataItem[];
      };
    }>("/library/onDeck");

    const items =
      data.MediaContainer.Metadata?.map((item) => ({
        ratingKey: item.ratingKey,
        title: item.title,
        type: item.type,
        thumb: item.thumb,
        year: item.year,
      })) || [];

    res.json({ items });
  } catch (err) {
    console.error("Error fetching on deck:", err);
    res.status(500).json({ error: "Failed to fetch on deck" });
  }
});

// GET /api/plex/related/:ratingKey
router.get("/related/:ratingKey", async (req: Request, res: Response) => {
  try {
    const ratingKey = req.params.ratingKey;
    const data = await plexJSON<{
      MediaContainer: {
        Metadata?: PlexMetadataItem[];
      };
    }>(`/library/metadata/${ratingKey}/related`);

    const items =
      data.MediaContainer.Metadata?.map((item) => ({
        ratingKey: item.ratingKey,
        title: item.title,
        type: item.type,
        thumb: item.thumb,
        year: item.year,
      })) || [];

    res.json({ items });
  } catch (err) {
    console.error("Error fetching related:", err);
    res.status(500).json({ error: "Failed to fetch related items" });
  }
});

// POST /api/plex/scrobble/:ratingKey
router.post("/scrobble/:ratingKey", async (req: Request, res: Response) => {
  try {
    const ratingKey = req.params.ratingKey;
    const { progress } = req.body;

    await plexFetch(`/:/progress`, {
      key: `/library/metadata/${ratingKey}`,
      progress: progress?.toString() || "0",
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Error scrobbling:", err);
    res.status(500).json({ error: "Failed to scrobble" });
  }
});

// POST /api/plex/played/:ratingKey
router.post("/played/:ratingKey", async (req: Request, res: Response) => {
  try {
    const ratingKey = req.params.ratingKey;
    const action = req.query.unscrobble === "1" ? "unscrobble" : "scrobble";

    await plexFetch(`/:/${action}`, {
      key: `/library/metadata/${ratingKey}`,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Error marking played:", err);
    res.status(500).json({ error: "Failed to mark as played" });
  }
});

// GET /api/plex/rating-key-from-guid
router.get("/rating-key-from-guid", async (req: Request, res: Response) => {
  try {
    const guid = req.query.guid as string;
    if (!guid) {
      return res.status(400).json({ error: "guid query parameter required" });
    }

    const data = await plexJSON<{
      MediaContainer: {
        Metadata?: PlexMetadataItem[];
      };
    }>("/library/all", {
      guid,
    });

    const metadata = data.MediaContainer.Metadata?.[0];
    if (!metadata) {
      return res.status(404).json({ error: "Item not found" });
    }

    res.json({
      ratingKey: metadata.ratingKey,
      title: metadata.title,
      type: metadata.type,
    });
  } catch (err) {
    console.error("Error fetching rating key from guid:", err);
    res.status(500).json({ error: "Failed to fetch rating key from guid" });
  }
});

export default router;
