import fetch from "node-fetch";
import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const SHEET_URL = process.env.SHEET_URL;

async function run() {
  const res = await fetch(SHEET_URL);
  const games = await res.json();

  const results = [];
  const now = new Date().toISOString();
  const nowMs = Date.now();
  const day = 24 * 60 * 60 * 1000;

  for (const game of games) {
    const appid = String(game.steam_appid);
    const tagId = String(game.gr_tag_id);

    const steamRes = await fetch(
      `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${appid}`
    );

    const steamJson = await steamRes.json();
    const players = Number(steamJson?.response?.player_count) || 0;

    const stored = await redis.get(`steam:${appid}`);

    const existingPeak = Number(stored?.allTimePeak) || game.all_time_peak || 0;
    const allTimePeak = Math.max(existingPeak, players);

    let peak24h = Number(stored?.peak24h) || players;
    let peak24hAt = stored?.peak24hAt || now;

    if (!stored?.peak24hAt || nowMs - new Date(stored.peak24hAt) > day) {
      peak24h = players;
      peak24hAt = now;
    } else if (players > peak24h) {
      peak24h = players;
      peak24hAt = now;
    }

    const record = {
      tagId: Number(tagId),
      appid: Number(appid),
      name: game.clean_game_name,
      players,
      allTimePeak,
      peak24h,
      peak24hAt,
      updatedAt: now,
    };

    await redis.set(`tag:${tagId}`, record);
    await redis.set(`steam:${appid}`, record);

    results.push(record);
  }

  const top10 = results.sort((a, b) => b.players - a.players).slice(0, 10);
  await redis.set("steam:top10", top10);

  console.log("Done:", results.length);
}

run();
