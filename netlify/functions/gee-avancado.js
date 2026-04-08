// netlify/functions/gee-avancado.js
// Análises ambientais avançadas via Google Earth Engine (GEE).
//
// Endpoints:
//   ?mode=desmatamento  &geometry=[[lng,lat],...] &anoBase=YYYY &anoComp=YYYY &cloud=N
//       Detecta desmatamento/supressão entre dois anos numa região desenhada
//       Retorna { tileUrl, anoBase, anoComp, areaHa, ndviBaseStats, ndviCompStats }
//
//   ?mode=regeneracao   &geometry=[[lng,lat],...] &anoInicio=YYYY &anoFim=YYYY &cloud=N
//       Análise de regeneração (ganho de NDVI) ao longo do tempo
//       Retorna { tileUrl, anoInicio, anoFim, serieNDVI:[{ano,ndvi},...], ganhoPercent }
//
//   ?mode=topo_morro    &geometry=[[lng,lat],...] &percentual=N (default 2/3)
//       APP de topo de morro: identifica cumes, base e faixa dos 2/3 superiores
//       Retorna { tileUrl, altMin, altMax, altCume, altBase2_3, areaHa }
//
//   ?mode=declividade   &geometry=[[lng,lat],...] (opcional — sem geometry = view extent)
//       &minLat=N &maxLat=N &minLng=N &maxLng=N
//       Classifica declividade e retorna camada classificada
//       Retorna { tileUrl, stats:{flat,suave,moderada,forte,app} }

var ee = require('@google/earthengine');

var CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

var CACHE_HEADER = { 'Cache-Control': 'public, max-age=1800' };

function send(cb, status, body, extra) {
  cb(null, {
    statusCode: status,
    headers:    Object.assign({}, CORS, extra || {}),
    body:       JSON.stringify(body)
  });
}

// ── Singleton GEE ────────────────────────────────────────────────────────────
var _ready   = false;
var _initErr = null;

function withEE(pk, fn, cb) {
  if (_ready)   { fn(); return; }
  if (_initErr) { send(cb, 500, { error: 'GEE init anterior falhou: ' + _initErr }); return; }

  ee.data.authenticateViaPrivateKey(pk, function() {
    ee.initialize(null, null, function() {
      _ready = true;
      fn();
    }, function(err) { _initErr = err; send(cb, 500, { error: 'GEE init: ' + err }); });
  }, function(err) { _initErr = err; send(cb, 500, { error: 'GEE auth: ' + err }); });
}

// ── Helper: monta coleção Landsat L2 escalada ────────────────────────────────
function getLandsat(year, cloudMax) {
  var s = year + '-01-01';
  var e = year + '-12-31';
  var c = cloudMax || 20;

  var scale = function(img) {
    return img.select(['SR_B.*'])
      .multiply(0.0000275).add(-0.2)
      .copyProperties(img, ['system:time_start']);
  };

  var col;
  if (year >= 2022) {
    col = ee.ImageCollection('LANDSAT/LC09/C02/T1_L2')
      .filterDate(s, e).filter(ee.Filter.lt('CLOUD_COVER', c))
      .map(function(img) {
        return scale(img).select(
          ['SR_B4','SR_B3','SR_B2','SR_B5','SR_B6','SR_B7'],
          ['R','G','B','NIR','SWIR1','SWIR2']);
      });
  } else if (year >= 2013) {
    col = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
      .filterDate(s, e).filter(ee.Filter.lt('CLOUD_COVER', c))
      .map(function(img) {
        return scale(img).select(
          ['SR_B4','SR_B3','SR_B2','SR_B5','SR_B6','SR_B7'],
          ['R','G','B','NIR','SWIR1','SWIR2']);
      });
  } else if (year >= 2003) {
    col = ee.ImageCollection('LANDSAT/LE07/C02/T1_L2')
      .filterDate(s, e).filter(ee.Filter.lt('CLOUD_COVER', c))
      .map(function(img) {
        return scale(img).select(
          ['SR_B3','SR_B2','SR_B1','SR_B4','SR_B5','SR_B7'],
          ['R','G','B','NIR','SWIR1','SWIR2']);
      });
  } else {
    col = ee.ImageCollection('LANDSAT/LT05/C02/T1_L2')
      .filterDate(s, e).filter(ee.Filter.lt('CLOUD_COVER', c))
      .map(function(img) {
        return scale(img).select(
          ['SR_B3','SR_B2','SR_B1','SR_B4','SR_B5','SR_B7'],
          ['R','G','B','NIR','SWIR1','SWIR2']);
      });
  }
  return col;
}

function ndviFromCol(col) {
  return col.median().normalizedDifference(['NIR','R']).rename('NDVI');
}

// ── Helper: parse geometry do body/params ────────────────────────────────────
function parseGeometry(p, body) {
  var geomStr = p.geometry || (body && body.geometry);
  if (!geomStr) return null;
  try {
    var coords = typeof geomStr === 'string' ? JSON.parse(geomStr) : geomStr;
    // coords: [[lng,lat],...] — fechado ou aberto
    if (coords.length < 3) return null;
    return ee.Geometry.Polygon([coords]);
  } catch(e) { return null; }
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = function(event, context, callback) {
  if (event.httpMethod === 'OPTIONS') {
    return callback(null, { statusCode: 204, headers: CORS, body: '' });
  }

  var p    = event.queryStringParameters || {};
  var body = {};
  if (event.body) { try { body = JSON.parse(event.body); } catch(e) {} }

  var mode = p.mode || (body && body.mode);
  if (!mode) return send(callback, 400, { error: 'Parâmetro mode ausente' });

  var VALID = ['desmatamento','regeneracao','topo_morro','declividade'];
  if (VALID.indexOf(mode) === -1) {
    return send(callback, 400, { error: 'mode inválido. Use: ' + VALID.join(' | ') });
  }

  var pk;
  try { pk = JSON.parse(process.env.GEE_SERVICE_ACCOUNT_KEY); }
  catch(e) { return send(callback, 500, { error: 'GEE_SERVICE_ACCOUNT_KEY não configurada' }); }

  withEE(pk, function() {

    // ════════════════════════════════════════════════════════════════════════
    // 1. DETECTOR DE DESMATAMENTO (temporal)
    // ════════════════════════════════════════════════════════════════════════
    if (mode === 'desmatamento') {
      var anoBase = parseInt(p.anoBase || (body && body.anoBase) || 2015);
      var anoComp = parseInt(p.anoComp || (body && body.anoComp) || (new Date().getFullYear() - 1));
      var cloud   = parseInt(p.cloud   || (body && body.cloud)   || 20);
      var geom    = parseGeometry(p, body);

      if (!geom) return send(callback, 400, { error: 'geometry obrigatório: [[lng,lat],...]' });
      if (anoBase >= anoComp) return send(callback, 400, { error: 'anoBase deve ser menor que anoComp' });

      var ndviBase = ndviFromCol(getLandsat(anoBase, cloud).filterBounds(geom));
      var ndviComp = ndviFromCol(getLandsat(anoComp, cloud).filterBounds(geom));

      // Diferença: negativo = perda de vegetação (provável desmatamento)
      var diff = ndviComp.subtract(ndviBase).rename('dNDVI');

      // Máscara de desmatamento: perda significativa de NDVI (< -0.15)
      var threshold = -0.15;
      var desmat = diff.lt(threshold).selfMask().rename('desmatamento');

      // Camada visual: diff com destaque vermelho nas áreas desmatadas
      var visualDiff = diff.visualize({
        min: -0.5, max: 0.5,
        palette: ['7f0000','d73027','f46d43','fee08b','ffffbf','d9ef8b','66bd63','1a9850','004529']
      });

      // Sobreposição de máscara de desmatamento em vermelho sólido
      var desmatVis = desmat.visualize({ palette: ['ff0000'] });

      // Blendagem: onde há desmatamento, mostra vermelho; senão, mostra diff
      var blended = ee.Image.cat([visualDiff, desmatVis]).reduce(ee.Reducer.firstNonNull());

      // Calcula área desmatada (pixeis < threshold) dentro da geometria
      var area = desmat.multiply(ee.Image.pixelArea()).reduceRegion({
        reducer: ee.Reducer.sum(),
        geometry: geom,
        scale: 30,
        maxPixels: 1e9,
        bestEffort: true
      });

      // Estatísticas de NDVI base e comp dentro da geometria
      var statsBase = ndviBase.reduceRegion({
        reducer: ee.Reducer.mean().combine({ reducer2: ee.Reducer.stdDev(), sharedInputs: true }),
        geometry: geom, scale: 30, maxPixels: 1e9, bestEffort: true
      });
      var statsComp = ndviComp.reduceRegion({
        reducer: ee.Reducer.mean().combine({ reducer2: ee.Reducer.stdDev(), sharedInputs: true }),
        geometry: geom, scale: 30, maxPixels: 1e9, bestEffort: true
      });

      // Obtém tile e stats em paralelo
      visualDiff.clip(geom).getMapId({
        bands: ['vis-red','vis-green','vis-blue'], min: 0, max: 255
      }, function(mapId, err) {
        if (err) return send(callback, 500, { error: 'desmatamento getMapId: ' + err });

        ee.Dictionary.fromLists(
          ['area','statsBase','statsComp'],
          [area, statsBase, statsComp]
        ).evaluate(function(vals, errV) {
          if (errV) {
            // Retorna pelo menos o tile
            return send(callback, 200, {
              tileUrl: mapId.urlFormat, mode: 'desmatamento',
              anoBase: anoBase, anoComp: anoComp, areaHa: null
            }, CACHE_HEADER);
          }

          var areaM2  = (vals.area   && vals.area.desmatamento)   ? vals.area.desmatamento   : 0;
          var areaHa  = Math.round(areaM2 / 10000 * 100) / 100;
          var ndviB   = vals.statsBase  || {};
          var ndviC   = vals.statsComp  || {};

          send(callback, 200, {
            tileUrl:      mapId.urlFormat,
            mode:         'desmatamento',
            anoBase:      anoBase,
            anoComp:      anoComp,
            threshold:    threshold,
            areaHa:       areaHa,
            ndviBase:     {
              mean:   ndviB['NDVI_mean']   !== undefined ? Math.round(ndviB['NDVI_mean']   * 1000)/1000 : null,
              stdDev: ndviB['NDVI_stdDev'] !== undefined ? Math.round(ndviB['NDVI_stdDev'] * 1000)/1000 : null
            },
            ndviComp: {
              mean:   ndviC['NDVI_mean']   !== undefined ? Math.round(ndviC['NDVI_mean']   * 1000)/1000 : null,
              stdDev: ndviC['NDVI_stdDev'] !== undefined ? Math.round(ndviC['NDVI_stdDev'] * 1000)/1000 : null
            }
          }, CACHE_HEADER);
        });
      });

    // ════════════════════════════════════════════════════════════════════════
    // 2. ANÁLISE DE REGENERAÇÃO (PRAD)
    // ════════════════════════════════════════════════════════════════════════
    } else if (mode === 'regeneracao') {
      var anoInicio = parseInt(p.anoInicio || (body && body.anoInicio) || 2010);
      var anoFim    = parseInt(p.anoFim    || (body && body.anoFim)    || (new Date().getFullYear() - 1));
      var cloud     = parseInt(p.cloud     || (body && body.cloud)     || 20);
      var geom      = parseGeometry(p, body);

      if (!geom) return send(callback, 400, { error: 'geometry obrigatório: [[lng,lat],...]' });
      if (anoInicio >= anoFim) return send(callback, 400, { error: 'anoInicio deve ser menor que anoFim' });

      // Calcula NDVI médio por ano (série temporal)
      var anos = [];
      for (var a = anoInicio; a <= anoFim; a++) anos.push(a);

      // Imagens NDVI base e final para visualização
      var ndviInicio = ndviFromCol(getLandsat(anoInicio, cloud).filterBounds(geom));
      var ndviFim    = ndviFromCol(getLandsat(anoFim,    cloud).filterBounds(geom));
      var diffReg    = ndviFim.subtract(ndviInicio).rename('ganho');

      var visReg = diffReg.visualize({
        min: -0.3, max: 0.5,
        palette: ['d73027','f46d43','fee08b','ffffbf','a6d96a','1a9850','004529']
      });

      // Série temporal: apenas amostra anos espaçados (max 8 pontos) para performance
      var step   = Math.max(1, Math.ceil(anos.length / 8));
      var sample = anos.filter(function(_, i) { return i % step === 0 || _ === anoFim; });

      var serieFuncs = sample.map(function(ano) {
        var nd = ndviFromCol(getLandsat(ano, cloud).filterBounds(geom));
        return nd.reduceRegion({
          reducer: ee.Reducer.mean(),
          geometry: geom, scale: 30, maxPixels: 1e9, bestEffort: true
        }).set('ano', ano);
      });

      visReg.clip(geom).getMapId({
        bands: ['vis-red','vis-green','vis-blue'], min: 0, max: 255
      }, function(mapId, err) {
        if (err) return send(callback, 500, { error: 'regeneracao getMapId: ' + err });

        // Avalia série temporal
        ee.List(serieFuncs).evaluate(function(serie, errS) {
          var serieNDVI = [];
          var ganhoPercent = null;

          if (!errS && serie) {
            serieNDVI = serie.map(function(item) {
              return { ano: item.ano, ndvi: item.NDVI !== undefined ? Math.round(item.NDVI * 1000)/1000 : null };
            });

            // Calcula ganho percentual entre primeiro e último ano com dados
            var validos = serieNDVI.filter(function(s) { return s.ndvi !== null; });
            if (validos.length >= 2) {
              var primeiro = validos[0].ndvi;
              var ultimo   = validos[validos.length-1].ndvi;
              if (primeiro && primeiro !== 0) {
                ganhoPercent = Math.round(((ultimo - primeiro) / Math.abs(primeiro)) * 100);
              }
            }
          }

          send(callback, 200, {
            tileUrl:      mapId.urlFormat,
            mode:         'regeneracao',
            anoInicio:    anoInicio,
            anoFim:       anoFim,
            serieNDVI:    serieNDVI,
            ganhoPercent: ganhoPercent
          }, CACHE_HEADER);
        });
      });

    // ════════════════════════════════════════════════════════════════════════
    // 3. APP TOPO DE MORRO
    // ════════════════════════════════════════════════════════════════════════
    } else if (mode === 'topo_morro') {
      var geom      = parseGeometry(p, body);
      var percAPP   = parseFloat(p.percentual || (body && body.percentual) || 0.6667); // 2/3

      if (!geom) return send(callback, 400, { error: 'geometry obrigatório: [[lng,lat],...]' });
      if (percAPP <= 0 || percAPP > 1) percAPP = 0.6667;

      // Usa SRTM (global) como MDT
      var dem = ee.Image('USGS/SRTMGL1_003').select('elevation').clip(geom);

      // Estatísticas de elevação dentro da geometria
      var stats = dem.reduceRegion({
        reducer: ee.Reducer.percentile([0, 10, 50, 90, 100])
            .combine({ reducer2: ee.Reducer.mean(), sharedInputs: true }),
        geometry: geom, scale: 30, maxPixels: 1e9, bestEffort: true
      });

      stats.evaluate(function(s, err) {
        if (err) return send(callback, 500, { error: 'topo_morro stats: ' + err });

        var altMin  = s['elevation_p0']   || s['elevation_min']   || 0;
        var altMax  = s['elevation_p100'] || s['elevation_max']   || 0;
        var amplitude = altMax - altMin;

        // Critério APP topo de morro: cota 2/3 (ou customizável) acima da base
        var altCorte = altMin + (amplitude * percAPP);
        var altCume  = altMax;

        // Camada APP: pixels acima do corte
        var app = dem.gte(altCorte).selfMask();

        // Camada de hillshade para visualização
        var hs = ee.Terrain.hillshade(dem, 315, 45);

        // Paleta hipsométrica + APP em vermelho
        var demVis = dem.visualize({ min: altMin, max: altMax,
          palette: ['313695','4575b4','74add1','ffffbf','fee090','f46d43','d73027','a50026'] });

        var appVis = app.visualize({ palette: ['ff0000'] });

        // Blend: base hipsométrica + overlay APP
        var hsNorm  = hs.divide(255).multiply(1.2).clamp(0, 1.4);
        var blended = demVis.multiply(hsNorm).clamp(0, 255).uint8()
          .rename(['vis-red','vis-green','vis-blue']);

        blended.getMapId({ bands: ['vis-red','vis-green','vis-blue'], min: 0, max: 255 },
          function(mapId, errM) {
            if (errM) return send(callback, 500, { error: 'topo_morro getMapId: ' + errM });

            // Calcula área APP
            var areaApp = app.multiply(ee.Image.pixelArea()).reduceRegion({
              reducer: ee.Reducer.sum(),
              geometry: geom, scale: 30, maxPixels: 1e9, bestEffort: true
            });

            areaApp.evaluate(function(areaVals, errA) {
              var areaHa = null;
              if (!errA && areaVals && areaVals.elevation) {
                areaHa = Math.round(areaVals.elevation / 10000 * 100) / 100;
              }

              send(callback, 200, {
                tileUrl:    mapId.urlFormat,
                mode:       'topo_morro',
                altMin:     Math.round(altMin),
                altMax:     Math.round(altMax),
                amplitude:  Math.round(amplitude),
                altCorte:   Math.round(altCorte),
                altCume:    Math.round(altCume),
                percAPP:    Math.round(percAPP * 100),
                areaAppHa:  areaHa
              }, CACHE_HEADER);
            });
          }
        );
      });

    // ════════════════════════════════════════════════════════════════════════
    // 4. DECLIVIDADE DINÂMICA
    // ════════════════════════════════════════════════════════════════════════
    } else if (mode === 'declividade') {
      var geom = parseGeometry(p, body);

      // Se não tiver geometria, usa bbox do mapa
      if (!geom) {
        var minLat = parseFloat(p.minLat || -90);
        var maxLat = parseFloat(p.maxLat ||  90);
        var minLng = parseFloat(p.minLng || -180);
        var maxLng = parseFloat(p.maxLng ||  180);
        if ([minLat,maxLat,minLng,maxLng].some(isNaN)) {
          return send(callback, 400, { error: 'Forneça geometry ou minLat/maxLat/minLng/maxLng' });
        }
        geom = ee.Geometry.Rectangle([minLng, minLat, maxLng, maxLat]);
      }

      var dem   = ee.Image('USGS/SRTMGL1_003').select('elevation');
      var slope = ee.Terrain.slope(dem); // graus

      // Conversão de graus para %: tan(graus) * 100
      var slopePercent = slope.tan().multiply(100).rename('slope_pct');

      // Classificação:
      // 0  = Plano/suave (< 3%)
      // 1  = Suave ondulado (3–8%)
      // 2  = Moderado (8–20%)
      // 3  = Forte ondulado (20–45%)
      // 4  = APP - escarpado (≥ 45%)
      var classes = slopePercent.expression(
        "(b('slope_pct') >= 45) ? 4 " +
        ": (b('slope_pct') >= 20) ? 3 " +
        ": (b('slope_pct') >= 8)  ? 2 " +
        ": (b('slope_pct') >= 3)  ? 1 " +
        ": 0"
      ).rename('classe').clip(geom);

      // Paleta: verde claro → amarelo → laranja → vermelho → roxo/app
      var palette = ['66bb6a','ffee58','ffa726','ef5350','9c27b0'];
      var classVis = classes.visualize({ min: 0, max: 4, palette: palette });

      // Área por classe
      var pixArea = ee.Image.pixelArea();
      var statsArea = classes.addBands(pixArea.rename('area'))
        .reduceRegion({
          reducer:     ee.Reducer.sum().group({ groupField: 0, groupName: 'classe' }),
          geometry:    geom,
          scale:       30,
          maxPixels:   1e9,
          bestEffort:  true
        });

      classVis.getMapId({ bands: ['vis-red','vis-green','vis-blue'], min: 0, max: 255 },
        function(mapId, err) {
          if (err) return send(callback, 500, { error: 'declividade getMapId: ' + err });

          statsArea.evaluate(function(areaVals, errA) {
            var stats = { plano:0, suave:0, moderado:0, forte:0, app:0 };
            var labels = ['plano','suave','moderado','forte','app'];

            if (!errA && areaVals && areaVals.groups) {
              areaVals.groups.forEach(function(g) {
                var idx = parseInt(g.classe);
                var ha  = Math.round((g.area / 10000) * 100) / 100;
                if (labels[idx]) stats[labels[idx]] = ha;
              });
            }

            send(callback, 200, {
              tileUrl:  mapId.urlFormat,
              mode:     'declividade',
              palette:  palette,
              classes:  [
                { label: 'Plano / Suave (< 3%)',         cor: palette[0], ha: stats.plano    },
                { label: 'Suave ondulado (3–8%)',        cor: palette[1], ha: stats.suave    },
                { label: 'Moderado (8–20%)',             cor: palette[2], ha: stats.moderado },
                { label: 'Forte ondulado (20–45%)',      cor: palette[3], ha: stats.forte    },
                { label: 'APP – Escarpado (≥ 45%)',      cor: palette[4], ha: stats.app      }
              ],
              stats: stats
            }, CACHE_HEADER);
          });
        }
      );
    }

  }, callback);
};
