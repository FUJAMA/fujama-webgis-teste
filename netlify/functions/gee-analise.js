// netlify/functions/gee-analise.js
var ee = require('@google/earthengine');

var CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

function send(cb, status, body, extra) {
  cb(null, { statusCode: status, headers: Object.assign({}, CORS, extra || {}), body: JSON.stringify(body) });
}

var _ready = false, _initErr = null;
function withEE(pk, fn, cb) {
  if (_ready)   { fn(); return; }
  if (_initErr) { return send(cb, 500, { error: 'GEE init: ' + _initErr }); }
  ee.data.authenticateViaPrivateKey(pk, function() {
    ee.initialize(null, null, function() { _ready = true; fn(); },
      function(e) { _initErr = e; send(cb, 500, { error: 'GEE init: ' + e }); });
  }, function(e) { _initErr = e; send(cb, 500, { error: 'GEE auth: ' + e }); });
}

function landsatBands(year) {
  if (year >= 2022) return { col:'LANDSAT/LC09/C02/T1_L2', rgb:['SR_B4','SR_B3','SR_B2'], nir:'SR_B5', swir2:'SR_B7', green:'SR_B3' };
  if (year >= 2013) return { col:'LANDSAT/LC08/C02/T1_L2', rgb:['SR_B4','SR_B3','SR_B2'], nir:'SR_B5', swir2:'SR_B7', green:'SR_B3' };
  if (year >= 2003) return { col:'LANDSAT/LE07/C02/T1_L2', rgb:['SR_B3','SR_B2','SR_B1'], nir:'SR_B4', swir2:'SR_B7', green:'SR_B2' };
  return               { col:'LANDSAT/LT05/C02/T1_L2', rgb:['SR_B3','SR_B2','SR_B1'], nir:'SR_B4', swir2:'SR_B7', green:'SR_B2' };
}

// Calcula área (ha) por faixas de valor de um índice float
function calcClassStats(img, geom, scale, labels, thresholds, cb) {
  var results = [], pending = labels.length;
  function done() { if (--pending === 0) { results.sort(function(a,b){return a._i-b._i;}); cb(results.map(function(r){return{label:r.label,ha:r.ha};})); } }
  labels.forEach(function(label, i) {
    var masked;
    if (i === 0)               masked = img.lt(thresholds[0]).selfMask();
    else if (i===labels.length-1) masked = img.gte(thresholds[thresholds.length-1]).selfMask();
    else                       masked = img.gte(thresholds[i-1]).and(img.lt(thresholds[i])).selfMask();
    masked.multiply(ee.Image.pixelArea()).divide(10000)
      .reduceRegion({reducer:ee.Reducer.sum(),geometry:geom,scale:scale,maxPixels:1e9,bestEffort:true})
      .evaluate(function(s,err) {
        var ha=0; if(!err&&s){var k=Object.keys(s)[0]; if(k&&isFinite(s[k]))ha=Math.round(s[k]*100)/100;}
        results.push({_i:i,label:label,ha:ha}); done();
      });
  });
}

exports.handler = function(event, context, callback) {
  if (event.httpMethod==='OPTIONS') return callback(null,{statusCode:204,headers:CORS,body:''});
  var p={}, body={};
  p = event.queryStringParameters || {};
  if (event.body) { try{body=JSON.parse(event.body);}catch(e){} }
  var mode  = p.mode||body.mode||'';
  var CACHE = {'Cache-Control':'public, max-age=3600'};
  var pk;
  try{pk=JSON.parse(process.env.GEE_SERVICE_ACCOUNT_KEY);}
  catch(e){return send(callback,500,{error:'GEE_SERVICE_ACCOUNT_KEY nao configurada'});}
  var coords = body.coords||null;

  // ── TIMELAPSE ───────────────────────────────────────────────────────────────
  if (mode==='timelapse') {
    var yr=parseInt(p.year||body.year)||2015, cld=parseInt(p.cloud||body.cloud)||20;
    var info=landsatBands(yr);
    return withEE(pk,function(){
      ee.ImageCollection(info.col).filterDate(String(yr)+'-01-01',String(yr)+'-12-31')
        .filter(ee.Filter.lt('CLOUD_COVER',cld))
        .map(function(img){return img.select(info.rgb,['R','G','B']).multiply(0.0000275).add(-0.2).clamp(0,1);})
        .median().multiply(255).uint8()
        .getMapId({bands:['R','G','B'],min:0,max:255,gamma:1.4},function(m,err){
          if(err) return send(callback,500,{error:'timelapse: '+err});
          send(callback,200,{tileUrl:m.urlFormat,mode:'timelapse',year:yr},CACHE);
        });
    },callback);
  }

  // ── NDVI ────────────────────────────────────────────────────────────────────
  if (mode==='ndvi') {
    var yr=parseInt(p.year||body.year)||2020, cld=parseInt(p.cloud||body.cloud)||20, info=landsatBands(yr);
    return withEE(pk,function(){
      var col=ee.ImageCollection(info.col).filterDate(String(yr)+'-01-01',String(yr)+'-12-31')
        .filter(ee.Filter.lt('CLOUD_COVER',cld))
        .map(function(img){return img.select([info.nir,info.rgb[0]],['NIR','R']).multiply(0.0000275).add(-0.2).clamp(0,1);})
        .median();
      var idx=col.normalizedDifference(['NIR','R']);
      var geom=coords?ee.Geometry.Polygon([coords]):null;
      (geom?idx.clip(geom):idx).getMapId({min:-0.3,max:0.85,palette:['d73027','f46d43','fdae61','fee08b','ffffbf','d9ef8b','a6d96a','66bd63','1a9850','006837']},function(m,err){
        if(err) return send(callback,500,{error:'ndvi: '+err});
        if(!geom) return send(callback,200,{tileUrl:m.urlFormat,mode:'ndvi',year:yr},CACHE);
        calcClassStats(idx,geom,30,['Muito Baixo (< −0.1)','Baixo (−0.1 a 0.2)','Médio (0.2 a 0.5)','Alto (0.5 a 0.7)','Muito Alto (> 0.7)'],[-0.1,0.2,0.5,0.7],function(cls){
          send(callback,200,{tileUrl:m.urlFormat,mode:'ndvi',year:yr,stats:{classes:cls}},CACHE);
        });
      });
    },callback);
  }

  // ── EVI ─────────────────────────────────────────────────────────────────────
  if (mode==='evi') {
    var yr=parseInt(p.year||body.year)||2020, cld=parseInt(p.cloud||body.cloud)||20, info=landsatBands(yr);
    return withEE(pk,function(){
      var med=ee.ImageCollection(info.col).filterDate(String(yr)+'-01-01',String(yr)+'-12-31')
        .filter(ee.Filter.lt('CLOUD_COVER',cld))
        .map(function(img){return img.select([info.nir,info.rgb[0],info.rgb[2]],['NIR','R','B']).multiply(0.0000275).add(-0.2).clamp(0,1);})
        .median();
      var idx=med.expression('2.5*((NIR-R)/(NIR+6.0*R-7.5*B+1.0))',{NIR:med.select('NIR'),R:med.select('R'),B:med.select('B')});
      var geom=coords?ee.Geometry.Polygon([coords]):null;
      (geom?idx.clip(geom):idx).getMapId({min:-0.2,max:0.8,palette:['d73027','f46d43','fdae61','fee08b','ffffbf','d9ef8b','a6d96a','66bd63','1a9850','005a32']},function(m,err){
        if(err) return send(callback,500,{error:'evi: '+err});
        if(!geom) return send(callback,200,{tileUrl:m.urlFormat,mode:'evi',year:yr},CACHE);
        calcClassStats(idx,geom,30,['Muito Baixo (< 0.0)','Baixo (0.0 a 0.2)','Médio (0.2 a 0.4)','Alto (0.4 a 0.6)','Muito Alto (> 0.6)'],[0.0,0.2,0.4,0.6],function(cls){
          send(callback,200,{tileUrl:m.urlFormat,mode:'evi',year:yr,stats:{classes:cls}},CACHE);
        });
      });
    },callback);
  }

  // ── NBR ─────────────────────────────────────────────────────────────────────
  if (mode==='nbr') {
    var yr=parseInt(p.year||body.year)||2020, cld=parseInt(p.cloud||body.cloud)||20, info=landsatBands(yr);
    return withEE(pk,function(){
      var col=ee.ImageCollection(info.col).filterDate(String(yr)+'-01-01',String(yr)+'-12-31')
        .filter(ee.Filter.lt('CLOUD_COVER',cld))
        .map(function(img){return img.select([info.nir,info.swir2],['NIR','SWIR2']).multiply(0.0000275).add(-0.2).clamp(0,1);})
        .median();
      var idx=col.normalizedDifference(['NIR','SWIR2']);
      var geom=coords?ee.Geometry.Polygon([coords]):null;
      (geom?idx.clip(geom):idx).getMapId({min:-0.5,max:0.9,palette:['7a0403','d44d00','f5a623','ffffbe','c7e9b4','41b6c4','225ea8','0c2c84']},function(m,err){
        if(err) return send(callback,500,{error:'nbr: '+err});
        if(!geom) return send(callback,200,{tileUrl:m.urlFormat,mode:'nbr',year:yr},CACHE);
        calcClassStats(idx,geom,30,['Queimado Severo (< −0.25)','Queimado Moderado (−0.25 a 0.1)','Não Queimado (0.1 a 0.27)','Vegetação Sadia (0.27 a 0.66)','Vegetação Densa (> 0.66)'],[-0.25,0.1,0.27,0.66],function(cls){
          send(callback,200,{tileUrl:m.urlFormat,mode:'nbr',year:yr,stats:{classes:cls}},CACHE);
        });
      });
    },callback);
  }

  // ── NDWI ────────────────────────────────────────────────────────────────────
  if (mode==='ndwi') {
    var yr=parseInt(p.year||body.year)||2020, cld=parseInt(p.cloud||body.cloud)||20, info=landsatBands(yr);
    return withEE(pk,function(){
      var col=ee.ImageCollection(info.col).filterDate(String(yr)+'-01-01',String(yr)+'-12-31')
        .filter(ee.Filter.lt('CLOUD_COVER',cld))
        .map(function(img){return img.select([info.green,info.nir],['G','NIR']).multiply(0.0000275).add(-0.2).clamp(0,1);})
        .median();
      var idx=col.normalizedDifference(['G','NIR']);
      var geom=coords?ee.Geometry.Polygon([coords]):null;
      (geom?idx.clip(geom):idx).getMapId({min:-0.5,max:0.5,palette:['d7191c','fdae61','ffffbf','abd9e9','2c7bb6']},function(m,err){
        if(err) return send(callback,500,{error:'ndwi: '+err});
        if(!geom) return send(callback,200,{tileUrl:m.urlFormat,mode:'ndwi',year:yr},CACHE);
        calcClassStats(idx,geom,30,['Solo Seco (< −0.2)','Solo/Veg. Seca (−0.2 a 0.0)','Úmido (0.0 a 0.2)','Muito Úmido (0.2 a 0.4)','Água (> 0.4)'],[-0.2,0.0,0.2,0.4],function(cls){
          send(callback,200,{tileUrl:m.urlFormat,mode:'ndwi',year:yr,stats:{classes:cls}},CACHE);
        });
      });
    },callback);
  }

  // ── DIFF NDVI ───────────────────────────────────────────────────────────────
  if (mode==='diffndvi') {
    var yr1=parseInt(p.year||body.year)||2023, yr2=parseInt(p.year2||body.year2)||2015;
    var cld=parseInt(p.cloud||body.cloud)||20;
    var base=Math.min(yr1,yr2), comp=Math.max(yr1,yr2);
    if(base===comp) return send(callback,400,{error:'year e year2 devem ser diferentes'});
    var ib=landsatBands(base), ic=landsatBands(comp);
    return withEE(pk,function(){
      var nb=ee.ImageCollection(ib.col).filterDate(String(base)+'-01-01',String(base)+'-12-31').filter(ee.Filter.lt('CLOUD_COVER',cld)).map(function(img){return img.select([ib.nir,ib.rgb[0]],['NIR','R']).multiply(0.0000275).add(-0.2).clamp(0,1);}).median().normalizedDifference(['NIR','R']);
      var nc=ee.ImageCollection(ic.col).filterDate(String(comp)+'-01-01',String(comp)+'-12-31').filter(ee.Filter.lt('CLOUD_COVER',cld)).map(function(img){return img.select([ic.nir,ic.rgb[0]],['NIR','R']).multiply(0.0000275).add(-0.2).clamp(0,1);}).median().normalizedDifference(['NIR','R']);
      var diff=nc.subtract(nb);
      var geom=coords?ee.Geometry.Polygon([coords]):null;
      (geom?diff.clip(geom):diff).getMapId({min:-0.5,max:0.5,palette:['7f0000','d73027','f46d43','fee08b','ffffbf','d9ef8b','66bd63','1a9850','004529']},function(m,err){
        if(err) return send(callback,500,{error:'diffndvi: '+err});
        if(!geom) return send(callback,200,{tileUrl:m.urlFormat,mode:'diffndvi',yearBase:base,yearComp:comp},CACHE);
        calcClassStats(diff,geom,30,['Perda Alta (< −0.2)','Perda Moderada (−0.2 a −0.05)','Estável (−0.05 a 0.05)','Ganho Moderado (0.05 a 0.2)','Ganho Alto (> 0.2)'],[-0.2,-0.05,0.05,0.2],function(cls){
          send(callback,200,{tileUrl:m.urlFormat,mode:'diffndvi',yearBase:base,yearComp:comp,stats:{classes:cls}},CACHE);
        });
      });
    },callback);
  }

  // ── DESMATAMENTO (Sentinel-2 · NBR) ─────────────────────────────────────────
  if (mode==='desmatamento') {
    var c2=body.coords, antesIni=body.antes_ini||'2017-01-01', antesFim=body.antes_fim||'2019-12-31';
    var depoisIni=body.depois_ini||'2022-01-01', depoisFim=body.depois_fim||'2024-12-31';
    var dsmCloud=parseInt(body.cloud)||40, threshold=parseFloat(body.threshold)||-0.1;
    if(!c2||c2.length<3) return send(callback,400,{error:'coords: minimo 3 pontos'});
    // Simplifica o polígono se tiver muitos vértices (reduz timeout no GEE)
    var coords = c2;
    if (coords.length > 200) {
      var step = Math.ceil(coords.length / 150);
      coords = coords.filter(function(_, i){ return i % step === 0; });
      if (coords[coords.length-1][0]!==coords[0][0]||coords[coords.length-1][1]!==coords[0][1]) coords.push(coords[0]);
    }
    return withEE(pk,function(){
      var geom=ee.Geometry.Polygon([coords]);
      function prepNBR(img){
        var mask=img.select('MSK_CLDPRB').lt(dsmCloud);
        var nir=img.select('B8').multiply(0.0001), swir2=img.select('B12').multiply(0.0001);
        return nir.subtract(swir2).divide(nir.add(swir2).add(1e-6)).rename('NBR').updateMask(mask);
      }
      var antes=ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED').filterBounds(geom).filterDate(antesIni,antesFim).map(prepNBR).median();
      var depois=ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED').filterBounds(geom).filterDate(depoisIni,depoisFim).map(prepNBR).median();
      var delta=depois.subtract(antes);
      var masked=delta.lt(threshold).selfMask();

      // Combina area suprimida + area total numa única chamada reduceRegion (paralela ao getMapId)
      var areaImg = masked.multiply(ee.Image.pixelArea()).divide(10000)
        .addBands(ee.Image.pixelArea().divide(10000).rename('total'));

      var results = {tileUrl:null, stats:null, err:null};
      var pending = 2;
      function tryFinish(){
        if(--pending > 0) return;
        if(results.err) return send(callback,500,{error:'desmatamento: '+results.err});
        send(callback,200,{tileUrl:results.tileUrl, stats:results.stats},{'Cache-Control':'no-cache'});
      }

      // Chamada 1: tile (renderização)
      masked.getMapId({palette:['ff2200']},function(m,err){
        if(err){ results.err=err; return tryFinish(); }
        results.tileUrl=m.urlFormat;
        tryFinish();
      });

      // Chamada 2: estatísticas de área (paralela ao tile)
      areaImg.reduceRegion({
        reducer:ee.Reducer.sum(),
        geometry:geom, scale:20, maxPixels:1e9, bestEffort:true
      }).evaluate(function(s,es){
        var areaHa=0, totalHa=null;
        if(!es && s){
          var keys=Object.keys(s);
          keys.forEach(function(k){
            if(isFinite(s[k])){
              if(k==='total') totalHa=Math.round(s[k]*100)/100;
              else areaHa=Math.round(s[k]*100)/100;
            }
          });
        }
        var pct=(totalHa&&totalHa>0)?Math.round(areaHa/totalHa*10000)/100:null;
        results.stats={areaHa:areaHa,totalHa:totalHa,percentual:pct,threshold:threshold,
          antesIni:antesIni,antesFim:antesFim,depoisIni:depoisIni,depoisFim:depoisFim};
        tryFinish();
      });
    },callback);
  }

  // ── EXPORT GEOTIFF ──────────────────────────────────────────────────────────
  if (mode==='export') {
    var expMode=body.exportMode||p.exportMode||'', expCoords=body.coords;
    if(!expCoords||expCoords.length<3) return send(callback,400,{error:'coords obrigatorio para export'});
    var cld=parseInt(body.cloud||p.cloud)||20, yr=parseInt(body.year||p.year)||2020;
    return withEE(pk,function(){
      var geom=ee.Geometry.Polygon([expCoords]), info=landsatBands(yr), image;
      function col(info2,yr2){
        return ee.ImageCollection(info2.col).filterDate(String(yr2)+'-01-01',String(yr2)+'-12-31').filter(ee.Filter.lt('CLOUD_COVER',cld));
      }
      if(expMode==='desmatamento'){
        var antesIni=body.antes_ini||'2017-01-01',antesFim=body.antes_fim||'2019-12-31';
        var depoisIni=body.depois_ini||'2022-01-01',depoisFim=body.depois_fim||'2024-12-31';
        var thr=parseFloat(body.threshold)||-0.1;
        function pNBR(img){var mask=img.select('MSK_CLDPRB').lt(cld);var n=img.select('B8').multiply(0.0001),s=img.select('B12').multiply(0.0001);return n.subtract(s).divide(n.add(s).add(1e-6)).rename('NBR').updateMask(mask);}
        var a=ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED').filterBounds(geom).filterDate(antesIni,antesFim).map(pNBR).median();
        var d=ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED').filterBounds(geom).filterDate(depoisIni,depoisFim).map(pNBR).median();
        image=d.subtract(a).rename('delta_NBR').clip(geom);
      } else if(expMode==='diffndvi'){
        var yr2=parseInt(body.year2)||2015,base=Math.min(yr,yr2),comp=Math.max(yr,yr2);
        var ib=landsatBands(base),ic=landsatBands(comp);
        var nb=col(ib,base).map(function(img){return img.select([ib.nir,ib.rgb[0]],['NIR','R']).multiply(0.0000275).add(-0.2).clamp(0,1);}).median().normalizedDifference(['NIR','R']);
        var nc=col(ic,comp).map(function(img){return img.select([ic.nir,ic.rgb[0]],['NIR','R']).multiply(0.0000275).add(-0.2).clamp(0,1);}).median().normalizedDifference(['NIR','R']);
        image=nc.subtract(nb).rename('delta_NDVI').clip(geom);
      } else if(expMode==='ndvi'){
        image=col(info,yr).map(function(img){return img.select([info.nir,info.rgb[0]],['NIR','R']).multiply(0.0000275).add(-0.2).clamp(0,1);}).median().normalizedDifference(['NIR','R']).rename('NDVI').clip(geom);
      } else if(expMode==='evi'){
        var med=col(info,yr).map(function(img){return img.select([info.nir,info.rgb[0],info.rgb[2]],['NIR','R','B']).multiply(0.0000275).add(-0.2).clamp(0,1);}).median();
        image=med.expression('2.5*((NIR-R)/(NIR+6*R-7.5*B+1))',{NIR:med.select('NIR'),R:med.select('R'),B:med.select('B')}).rename('EVI').clip(geom);
      } else if(expMode==='nbr'){
        image=col(info,yr).map(function(img){return img.select([info.nir,info.swir2],['NIR','SWIR2']).multiply(0.0000275).add(-0.2).clamp(0,1);}).median().normalizedDifference(['NIR','SWIR2']).rename('NBR').clip(geom);
      } else if(expMode==='ndwi'){
        image=col(info,yr).map(function(img){return img.select([info.green,info.nir],['G','NIR']).multiply(0.0000275).add(-0.2).clamp(0,1);}).median().normalizedDifference(['G','NIR']).rename('NDWI').clip(geom);
      } else { return send(callback,400,{error:'exportMode invalido: '+expMode}); }

      image.getDownloadURL({name:expMode+'_'+yr,region:geom,scale:30,crs:'EPSG:4326',format:'GEO_TIFF'},function(url,err){
        if(err) return send(callback,500,{error:'export: '+err});
        send(callback,200,{downloadUrl:url,mode:expMode});
      });
    },callback);
  }

  return send(callback,400,{error:'mode invalido: '+mode});
};
