import axios, { AxiosResponse } from 'axios';

import {
    InternetProviderLyricSearchResponse,
    LyricSearchQuery,
    LyricSource,
    LyricsResponse,
} from '.';
import { orderSearchResults } from './shared';

import log from '/@/main/logger';
import { SyncedWordCue, SynchronizedLyrics } from '/@/shared/types/domain-types';

const API_URL = 'https://lrc.red';

const TIMEOUT_MS = 5000;

export interface LrcRedSearchHit {
    album?: string;
    artist: string;
    cover?: string;
    duration?: number;
    isrc: string;
    title: string;
    year?: number;
}

export interface LrcRedSearchResponse {
    hits: LrcRedSearchHit[];
    next?: null | string;
}

const lineTimeExp = /\[(\d{2,}):(\d{2})(?:\.(\d{2,3}))?]([^\n]+)(\n|$)/g;

const wordTagExp = /<(\d{2,}):(\d{2})(?:\.(\d{2,3}))?>/g;

const stripHeaders = (lrc: string) => lrc.replace(/^\[(ti|ar|al|length):.*\]$/gm, '').trim();

const parseTime = (minute: string, sec: string, ms?: string) => {
    const minutes = parseInt(minute, 10);
    const seconds = parseInt(sec, 10);
    let millis = 0;
    if (ms) {
        millis = ms.length === 3 ? parseInt(ms, 10) : parseInt(ms, 10) * 10;
    }
    return (minutes * 60 + seconds) * 1000 + millis;
};

const parseLyrics = (lrc: string): null | SynchronizedLyrics => {
    const lines: SynchronizedLyrics = [];

    for (const line of lrc.matchAll(lineTimeExp)) {
        const [, minute, sec, ms, rawText] = line;
        const startMs = parseTime(minute, sec, ms);
        const text = rawText.replace(wordTagExp, '').trim();
        const wordTags = [...rawText.matchAll(wordTagExp)];

        if (wordTags.length === 0) {
            lines.push({ startMs, text });
            continue;
        }

        const words: SyncedWordCue[] = [];
        let cursor = 0;
        let prevTime = startMs;

        for (const tag of wordTags) {
            const [, wMinute, wSec, wMs] = tag;
            const tagTime = parseTime(wMinute, wSec, wMs);
            const wordText = rawText.slice(cursor, tag.index);

            if (wordText) {
                words.push({ endMs: tagTime, startMs: prevTime, text: wordText });
            }

            prevTime = tagTime;
            cursor = tag.index + tag[0].length;
        }

        const trailing = rawText.slice(cursor);
        if (trailing) {
            words.push({ endMs: prevTime, startMs: prevTime, text: trailing });
        }

        const endMs = words.length > 0 ? words[words.length - 1].endMs : startMs;

        lines.push({
            cueLines: [
                {
                    endMs,
                    index: lines.length,
                    startMs,
                    value: text,
                    words,
                },
            ],
            startMs,
            text,
        });
    }

    return lines.length > 0 ? lines : null;
};

export async function getLyricsBySongId(songId: string): Promise<LyricsResponse | null> {
    let result: AxiosResponse<string>;

    try {
        result = await axios.get<string>(`${API_URL}/s/${songId}.lrc`, {
            responseType: 'text',
            timeout: TIMEOUT_MS,
        });
    } catch (e) {
        log.error('lrc.red lyrics request errored:', (e as Error)?.message);
        return null;
    }

    const lrc = stripHeaders(result.data);
    if (!lrc) return null;

    return parseLyrics(lrc) ?? lrc;
}

export async function getSearchResults(
    params: LyricSearchQuery,
): Promise<InternetProviderLyricSearchResponse[] | null> {
    if (!params.name && !params.artist) return null;

    const query = [params.name, params.artist].filter(Boolean).join(' ');

    let result: AxiosResponse<LrcRedSearchResponse>;

    try {
        result = await axios.get<LrcRedSearchResponse>(`${API_URL}/search.json`, {
            params: { q: query },
            timeout: TIMEOUT_MS,
        });
    } catch (e) {
        log.error('lrc.red search request errored:', (e as Error)?.message);
        return null;
    }

    if (!result.data?.hits) return null;

    const songResults: InternetProviderLyricSearchResponse[] = result.data.hits.map((hit) => ({
        artist: hit.artist,
        id: hit.isrc,
        isSync: true,
        name: hit.title,
        source: LyricSource.LRCRED,
    }));

    return orderSearchResults({ params, results: songResults });
}
