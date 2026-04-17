// netlify/functions/inpe-tiles.js
// Proxy reverso para o INPE/BDC — contorna a falta de CORS do servidor.
// Suporta dois modos, selecionados pelo parâmetro ?mode=:
//
//  mode=search  → proxy da API STAC /search
//    ?mode=search&col=S2-16D-2&bbox=W,S,E,N&datetime=ini/fim&limit=100
//
//  mode=tile (padrão) → proxy do TMS tile
//    ?mode=tile&z=...&x=...&y=...&col=...&item=...&assets=B04,B03,B02
//    ?mode=tile&z=...&x=...&y=...&cogUrl=https://...

var https = require('https');
var http  = require('http');
var url   = require('url');

var CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

var INPE_STAC_BASE = 'https://data.inpe.br/bdc/stac/v1';
var INPE_TMS_STAC  = 'https://data.inpe.br/bdc/tms/stac/tiles/WebMercatorQuad';
var INPE_TMS_COG   = 'https://data.inpe.br/bdc/tms/tiles/WebMercatorQuad';

function fetchRaw(targetUrl, isBinary, callback) {
  var parsed = url.parse(targetUrl);
  var lib = parsed.protocol === 'https:' ? https : http;

  var req = lib.get(targetUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Netlify-Proxy; fujama-webgis)',
      'Accept': isBinary ? 'image/png,image/*,*/*' : 'application/json,*/*'
    }
  }, function(res) {
    var chunks = [];
    res.on('data', function(c) { chunks.push(c); });
    res.on('end', function() {
      callback(null, res.statusCode, res.headers, Buffer.concat(chunks));
    });
  });

  req.on('error', function(err) { callback(err); });
  req.setTimeout(25000, function() {
    req.destroy();
    callback(new Error('Timeout'));
  });
}

exports.handler = function(event, context, callback) {

  if (event.httpMethod === 'OPTIONS') {
    return callback(null, { statusCode: 204, headers: CORS, body: '' });
  }

  var p    = event.queryStringParameters || {};
  var mode = p.mode || 'tile';

  // ── MODO: STAC SEARCH ────────────────────────────────────────────────────
  if (mode === 'search') {
    var col      = p.col      || '';
    var bbox     = p.bbox     || '';
    var datetime = p.datetime || '';
    var limit    = p.limit    || '100';

    if (!col || !bbox || !datetime) {
      return callback(null, {
        statusCode: 400,
        headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ error: 'Parâmetros col, bbox e datetime obrigatórios' })
      });
    }

    var searchUrl = INPE_STAC_BASE + '/search' +
      '?collections=' + encodeURIComponent(col) +
      '&bbox=' + bbox +
      '&datetime=' + encodeURIComponent(datetime) +
      '&limit=' + limit;

    fetchRaw(searchUrl, false, function(err, status, headers, body) {
      if (err) {
        return callback(null, {
          statusCode: 502,
          headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }),
          body: JSON.stringify({ error: 'Proxy error: ' + err.message })
        });
      }
      callback(null, {
        statusCode: status,
        headers: Object.assign({}, CORS, {
          'Content-Type': headers['content-type'] || 'application/json',
          'Cache-Control': 'public, max-age=300'
        }),
        body: body.toString('utf8')
      });
    });

  // ── MODO: TMS TILE ───────────────────────────────────────────────────────
  } else {
    var z = p.z, x = p.x, y = p.y;

    if (!z || !x || !y) {
      return callback(null, {
        statusCode: 400,
        headers: Object.assign({}, CORS, { 'Content-Type': 'text/plain' }),
        body: 'Parâmetros z, x, y obrigatórios'
      });
    }

    var tmsUrl;

    if (p.cogUrl) {
      tmsUrl = INPE_TMS_COG + '/' + z + '/' + x + '/' + y +
        '?url=' + encodeURIComponent(p.cogUrl);

    } else if (p.col && p.item && p.assets) {
      var stacItemUrl = INPE_STAC_BASE + '/collections/' +
        encodeURIComponent(p.col) + '/items/' + encodeURIComponent(p.item);

      var assetList = p.assets.split(',');
      var assetsQs = assetList.map(function(a) {
        return 'assets=' + encodeURIComponent(a.trim());
      }).join('&');

      tmsUrl = INPE_TMS_STAC + '/' + z + '/' + x + '/' + y +
        '?url=' + encodeURIComponent(stacItemUrl) +
        '&' + assetsQs +
        '&rescale=' + encodeURIComponent(p.rescale || '0,3000') +
        '&color_formula=' + encodeURIComponent(p.color_formula || 'gamma rgb 1.3');

    } else {
      return callback(null, {
        statusCode: 400,
        headers: Object.assign({}, CORS, { 'Content-Type': 'text/plain' }),
        body: 'Forneça cogUrl OU (col + item + assets)'
      });
    }

    fetchRaw(tmsUrl, true, function(err, status, headers, body) {
      if (err) {
        return callback(null, {
          statusCode: 502,
          headers: Object.assign({}, CORS, { 'Content-Type': 'text/plain' }),
          body: 'Proxy error: ' + err.message
        });
      }

      if (status !== 200) {
        return callback(null, {
          statusCode: status,
          headers: Object.assign({}, CORS, { 'Content-Type': 'text/plain' }),
          body: 'INPE TMS ' + status + ': ' + body.toString('utf8').slice(0, 300)
        });
      }

      callback(null, {
        statusCode: 200,
        headers: Object.assign({}, CORS, {
          'Content-Type': headers['content-type'] || 'image/png',
          'Cache-Control': 'public, max-age=86400'
        }),
        body: body.toString('base64'),
        isBase64Encoded: true
      });
    });
  }
};
