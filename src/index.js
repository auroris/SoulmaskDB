/**
 * Steam64 → persona-name resolver (Cloudflare Worker entry point).
 *
 * GET  /api/steam/names?ids=A,B,C
 * POST /api/steam/names   body: {"ids": ["A","B","C"]}
 *
 * Returns a JSON array in the SAME ORDER as the input, one entry per
 * requested ID. Invalid IDs and IDs Steam doesn't recognize come back
 * as null (so the client can cache the negative result and not re-ask).
 *
 *   [ {steamid64, personaName, avatar, profileUrl} | null, ... ]
 *
 * Wiring:
 *   - STEAM_API_KEY        env var / `.dev.vars`
 *   - ALLOWED_ORIGIN       env var / `.dev.vars` (CORS origin allowed)
 *
 * Caching: edge cache for 24h. Clients should sort IDs before requesting
 * to maximize cache hits across users.
 */

const STEAM_API_URL = 'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/';
const STEAM_BATCH_SIZE = 100;
const MAX_IDS_PER_REQUEST = 500;
const STEAM_ID_RE = /^7656119\d{10}$/;
const NAMES_PATH = '/api/steam/names';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== NAMES_PATH) {
      return new Response('Not found', { status: 404 });
    }

    switch (request.method) {
      case 'OPTIONS':
        return new Response(null, { status: 204, headers: corsHeaders(env) });

      case 'GET': {
        const idsParam = url.searchParams.get('ids') || '';
        const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean);
        return handle(ids, env);
      }

      case 'POST': {
        let body;
        try { body = await request.json(); }
        catch { return errorResponse(400, 'invalid json body', env); }
        if (!body || !Array.isArray(body.ids)) {
          return errorResponse(400, 'expected {"ids":[...]}', env);
        }
        return handle(body.ids.map(String), env);
      }

      default:
        return errorResponse(405, 'method not allowed', env);
    }
  },
};

async function handle(ids, env) {
  if (ids.length === 0) return jsonResponse([], env);
  if (ids.length > MAX_IDS_PER_REQUEST) {
    return errorResponse(413, `too many ids (max ${MAX_IDS_PER_REQUEST} per request)`, env);
  }
  if (!env.STEAM_API_KEY) {
    return errorResponse(500, 'STEAM_API_KEY not configured', env);
  }

  const uniqueValid = [...new Set(ids.filter(id => STEAM_ID_RE.test(id)))];
  const lookup = new Map();

  if (uniqueValid.length > 0) {
    const batches = [];
    for (let i = 0; i < uniqueValid.length; i += STEAM_BATCH_SIZE) {
      batches.push(uniqueValid.slice(i, i + STEAM_BATCH_SIZE));
    }
    try {
      const results = await Promise.all(
        batches.map(b => fetchSteamBatch(b, env.STEAM_API_KEY))
      );
      for (const players of results) {
        for (const p of players) {
          lookup.set(p.steamid, {
            steamid64:   p.steamid,
            personaName: p.personaname || null,
            avatar:      p.avatarfull || p.avatarmedium || p.avatar || null,
            profileUrl:  p.profileurl || null,
          });
        }
      }
    } catch (err) {
      return errorResponse(502, `steam api error: ${err.message}`, env);
    }
  }

  const out = ids.map(id => STEAM_ID_RE.test(id) ? (lookup.get(id) || null) : null);
  return jsonResponse(out, env);
}

async function fetchSteamBatch(ids, apiKey) {
  const url = `${STEAM_API_URL}?key=${encodeURIComponent(apiKey)}&steamids=${ids.join(',')}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`steam returned ${r.status}`);
  const data = await r.json();
  return data?.response?.players || [];
}

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin':  env.ALLOWED_ORIGIN || '',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary':                         'Origin',
  };
}

function jsonResponse(data, env) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      'Content-Type':  'application/json',
      'Cache-Control': 'public, max-age=86400, s-maxage=86400',
      ...corsHeaders(env),
    },
  });
}

function errorResponse(status, msg, env) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(env),
    },
  });
}
