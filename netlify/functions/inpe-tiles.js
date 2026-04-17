// netlify/functions/inpe-tiles.js
// Proxy para os tiles TMS do INPE/BDC que não têm CORS habilitado.
// Recebe os parâmetros necessários e faz a requisição server-side,
// retornando o tile PNG com headers CORS corretos.
//
// Uso via Leaflet:
//   https://<netlify-site>/.netlify/functions/inpe-tiles?z={z}&x={x}&y={y}
//     &col=S2-16D-2&item=S2-16D_V2_027033_20230101&assets=B04,B03,B02&rescale=0,3000
//
// Para CBERS (COG direto):
//   &cogUrl=https://data.inpe.br/bdc/data/...

var https = require('https');
var http  = require('http');
var url   = require('url');

var CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

var INPE_TMS_STAC = 'https://data.inpe.br/bdc/tms/stac/tiles/WebMercatorQuad';
var INPE_TMS_COG  = 'https://data.inpe.br/bdc/tms/tiles/WebMercatorQuad';
var INPE_STAC_BASE = 'https://data.inpe.br/bdc/stac/v1';

exports.handler = function(event, context, callback) {

  if (event.httpMethod === 'OPTIONS') {
    return callback(null, { statusCode: 204, headers: CORS_HEADERS, body: '' });
  }

  var p = event.queryStringParameters || {};
  var z = p.z, x = p.x, y = p.y;

  if (!z || !x || !y) {
    return callback(null, {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: 'Parâmetros z, x, y obrigatórios'
    });
  }

  var tmsUrl;

  if (p.cogUrl) {
    // Modo COG direto (CBERS TCI)
    tmsUrl = INPE_TMS_COG + '/' + z + '/' + x + '/' + y +
      '?url=' + encodeURIComponent(p.cogUrl);

  } else if (p.col && p.item && p.assets) {
    // Modo STAC multi-asset (Sentinel, Landsat)
    var stacItemUrl = INPE_STAC_BASE + '/collections/' +
      encodeURIComponent(p.col) + '/items/' + encodeURIComponent(p.item);

    var assets = p.assets.split(',');
    var assetsQs = assets.map(function(a) {
      return 'assets=' + encodeURIComponent(a.trim());
    }).join('&');

    var rescale = p.rescale || '0,3000';
    var colorFormula = p.color_formula || 'gamma rgb 1.3';

    tmsUrl = INPE_TMS_STAC + '/' + z + '/' + x + '/' + y +
      '?url=' + encodeURIComponent(stacItemUrl) +
      '&' + assetsQs +
      '&rescale=' + encodeURIComponent(rescale) +
      '&color_formula=' + encodeURIComponent(colorFormula);

  } else {
    return callback(null, {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: 'Forneça cogUrl ou (col + item + assets)'
    });
  }

  // Faz o fetch server-side (sem CORS)
  var parsedUrl = url.parse(tmsUrl);
  var lib = parsedUrl.protocol === 'https:' ? https : http;

  var req = lib.get(tmsUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Netlify Function; fujama-webgis)',
      'Accept': 'image/png,image/*,*/*'
    }
  }, function(res) {
    var chunks = [];
    res.on('data', function(chunk) { chunks.push(chunk); });
    res.on('end', function() {
      var body = Buffer.concat(chunks);

      if (res.statusCode !== 200) {
        return callback(null, {
          statusCode: res.statusCode,
          headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'text/plain' }),
          body: 'INPE TMS error ' + res.statusCode + ': ' + body.toString('utf8').slice(0, 200)
        });
      }

      callback(null, {
        statusCode: 200,
        headers: Object.assign({}, CORS_HEADERS, {
          'Content-Type': res.headers['content-type'] || 'image/png',
          'Cache-Control': 'public, max-age=86400'
        }),
        body: body.toString('base64'),
        isBase64Encoded: true
      });
    });
  });

  req.on('error', function(err) {
    callback(null, {
      statusCode: 502,
      headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'text/plain' }),
      body: 'Proxy error: ' + err.message
    });
  });

  req.setTimeout(25000, function() {
    req.destroy();
    callback(null, {
      statusCode: 504,
      headers: Object.assign({}, CORS_HEADERS, { 'Content-Type': 'text/plain' }),
      body: 'Timeout ao buscar tile do INPE'
    });
  });
};
