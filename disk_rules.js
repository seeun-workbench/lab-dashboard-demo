// Disk health rules shared by the overview (nav warning dot) and the disk page.
// Thresholds: old SAS drives commonly carry a few grown defects, so 1-9
// reallocated sectors are shown in the details but not flagged.
(function (root) {
  'use strict';

  var STATE_LABEL = {
    onln: '사용 중', offln: '오프라인', ugood: '미사용', ugunsp: '미사용', ubad: '불량', ubunsp: '불량',
    rbld: '재구축 중', cpybck: '복사 중', ghs: '핫스페어', dhs: '전용 핫스페어', msng: '없음', jbod: 'JBOD',
    failed: '고장'
  };
  var VD_LABEL = { optl: '정상', dgrd: '성능 저하', pdgd: '부분 저하', ofln: '오프라인', rec: '복구 중', cac: '캐시 확인 중' };
  var BAD_STATES = { ubad: 1, ubunsp: 1, offln: 1, failed: 1, msng: 1 };
  // Unconfigured: in no RAID set, so a failing one is a replaced drive waiting
  // to be pulled out, not a risk to data.
  var OUTSIDE_RAID = { ugood: 1, ugunsp: 1, ubad: 1, ubunsp: 1 };
  var BUSY_STATES = { rbld: 1, cpybck: 1 };

  // Every limit the page colours by, as [caution at, danger at] (null = never).
  // The detail cells and the 항목 설명 list read these too, so change them here only.
  // HDD temperatures match the existing monitoring mail (WARNING 55 C, CRITICAL 60 C).
  var LIMITS = {
    temp_hdd: [55, 60], temp_ssd: [70, 80],
    realloc: [10, 100], wear_pct: [80, 95],
    pending: [null, 1], uncorrectable: [null, 1], pred_fail: [null, 1],
    media_err: [1, null],
    // Enclosure sensors are unnamed, but each has an air one and an expander chip one:
    // on 2026-10-30 every SC846-P chip read 79-88 C on all 8 servers (normal for it),
    // the air 24-39 C. So the air (lowest reading) is judged like a room, and the
    // chip (highest) only when it is far above what this model always shows.
    encl_air: [45, 50], encl_chip: [95, 100],
    // Unconfigured Bad drives on one controller: a few are replaced drives left in place,
    // many at once mean a lost enclosure (44 at once on one server: RAID sets gone).
    ubad_ctrl: [null, 5]
  };

  function isSsd(d) { return /ssd/i.test(d.med || ''); }
  function stateKey(d) { return String(d.state || '').toLowerCase(); }
  function temp(d) { return d.temp != null ? d.temp : (d.smart && d.smart.temp); }
  function tempLimits(d) { return isSsd(d) ? LIMITS.temp_ssd : LIMITS.temp_hdd; }
  function warmLimit(d) { return tempLimits(d)[0]; }
  function hotLimit(d) { return tempLimits(d)[1]; }
  function atLeast(v, lim) {
    if (typeof v !== 'number') return 'ok';
    return lim[1] != null && v >= lim[1] ? 'danger' : (lim[0] != null && v >= lim[0] ? 'caution' : 'ok');
  }

  // Level of each detail cell: {state, smart, temp, realloc, pending, ...}
  function levels(d) {
    var s = d.smart || {}, st = stateKey(d);
    return {
      state: BAD_STATES[st] ? 'danger' : (BUSY_STATES[st] ? 'caution' : 'ok'),
      smart: s.passed === false || d.smart_alert ? 'danger' : 'ok',
      temp: atLeast(temp(d), tempLimits(d)),
      realloc: atLeast(s.realloc, LIMITS.realloc),
      pending: atLeast(s.pending, LIMITS.pending),
      uncorrectable: atLeast(s.uncorrectable, LIMITS.uncorrectable),
      wear_pct: atLeast(s.wear_pct, LIMITS.wear_pct),
      media_err: atLeast(d.media_err, LIMITS.media_err),
      pred_fail: atLeast(d.pred_fail, LIMITS.pred_fail)
    };
  }

  // Returns {level: 'ok'|'caution'|'danger'|'remove', reasons: [...]}
  function judge(d) {
    var j = judgeHealth(d);
    if (j.level !== 'ok' && OUTSIDE_RAID[stateKey(d)]) return { level: 'remove', reasons: j.reasons };
    return j;
  }

  function judgeHealth(d) {
    var s = d.smart || {}, st = stateKey(d), L = levels(d);
    var danger = [], caution = [];
    var add = function (lvl, text) { if (lvl === 'danger') danger.push(text); else if (lvl === 'caution') caution.push(text); };
    if (L.state === 'danger') danger.push('상태 ' + (STATE_LABEL[st] || d.state));
    add(L.pred_fail, '예측 실패 ' + d.pred_fail);
    if (d.smart_alert) danger.push('SMART 경고');
    if (s.passed === false) danger.push('SMART 실패');
    add(L.pending, '보류 섹터 ' + s.pending);
    add(L.uncorrectable, '복구 불가 섹터 ' + s.uncorrectable);
    add(L.realloc, '재할당 섹터 ' + s.realloc);
    add(L.temp, '온도 ' + temp(d) + '°C');
    add(L.wear_pct, '마모 ' + s.wear_pct + '%');
    if (L.state === 'caution') caution.push(STATE_LABEL[st]);
    add(L.media_err, '매체 오류 ' + d.media_err);
    if (danger.length) return { level: 'danger', reasons: danger.concat(caution) };
    if (caution.length) return { level: 'caution', reasons: caution };
    return { level: 'ok', reasons: [] };
  }

  // {air, chip}: the lowest and highest reading; a lone sensor is taken as the chip
  // (a 90-bay JBOD's F39 and R39 read 68-74 C).
  function enclTemps(e) {
    var t = (e.temps || []).map(function (s) { return s.c; }).filter(function (c) { return typeof c === 'number'; });
    if (!t.length) return { air: null, chip: null };
    var lo = Math.min.apply(null, t), hi = Math.max.apply(null, t);
    return { air: t.length > 1 ? lo : null, chip: hi };
  }
  // A sensor storcli reports as not OK counts as caution even when its reading is low.
  function enclLevel(e) {
    var bad = (e.temps || []).some(function (s) { return s.status && !/^ok$/i.test(s.status) && !/unsupported|not\s*(installed|available)/i.test(s.status); });
    var t = enclTemps(e), a = atLeast(t.air, LIMITS.encl_air), c = atLeast(t.chip, LIMITS.encl_chip);
    var lvl = a === 'danger' || c === 'danger' ? 'danger' : (a === 'caution' || c === 'caution' ? 'caution' : 'ok');
    return lvl === 'ok' && bad ? 'caution' : lvl;
  }
  // RAID sets and enclosures this server had before and does not have now (disk_collect.py)
  function missing(d) {
    var m = (d && d.missing) || {};
    return { vds: m.vds || [], enclosures: m.enclosures || [] };
  }

  // Controllers with too many Unconfigured Bad drives: [{ctrl, n}]
  function manyBad(d) {
    var by = {};
    ((d && d.drives) || []).forEach(function (dr) {
      var st = stateKey(dr);
      if (st === 'ubad' || st === 'ubunsp') by[dr.ctrl] = (by[dr.ctrl] || 0) + 1;
    });
    return Object.keys(by).filter(function (c) { return by[c] >= LIMITS.ubad_ctrl[1]; })
      .map(function (c) { return { ctrl: c, n: by[c] }; });
  }

  // storcli's "Cache" column, e.g. NRAWBC: R/NR read-ahead, then AWB/WB/WT, then C/D
  function writePolicy(v) {
    var m = /(AWB|WB|WT)/.exec(String(v.cache || ''));
    return m ? m[1] : null;
  }
  // Always-write-back RAID sets whose controller has nothing healthy to keep the cache through
  // a power cut: [{id, ctrl, why, level}]. A controller storcli said nothing about is not judged.
  // No unit at all is how most servers were built (2026-11-02: all 8), so it is a note that
  // raises nothing; a unit that was there and is not healthy now is a caution.
  function cacheRisks(d) {
    var backup = (d && d.cache_backup) || {}, out = [];
    ((d && d.vds) || []).forEach(function (v) {
      var m = /^\/c(\d+)\//.exec(v.id || ''), c = m && m[1];
      if (writePolicy(v) !== 'AWB' || !(c in backup)) return;
      var b = backup[c];
      if (!b) out.push({ id: v.id, ctrl: c, why: '보호 장치 없음', level: 'info' });
      else if (!/^optimal$/i.test(b.state || '')) out.push({ id: v.id, ctrl: c, why: b.kind + ' ' + (b.state || '상태 알 수 없음'), level: 'caution' });
    });
    return out;
  }

  function cacheWarn(d) { return cacheRisks(d).filter(function (r) { return r.level === 'caution'; }); }

  function vdOk(v) { return String(v.state || '').toLowerCase() === 'optl'; }
  // Degraded or rebuilding RAID sets need attention; an offline one has lost data access.
  function vdLevel(v) {
    var k = String(v.state || '').toLowerCase();
    return k === 'optl' ? 'ok' : (k === 'ofln' ? 'danger' : 'caution');
  }

  // Disk data comes every 10 min; older than this it is not the server's current state.
  var STALE_S = 30 * 60;
  // A server marked 점검 중 that has stopped sending: what it sent last is from before the
  // power-off, not now, so it is not judged as current (monitoring tools do the same with a
  // planned downtime). A marked server that still sends is judged as usual.
  function held(x) {
    return !!x.maintenance && (!x.disks || Date.now() / 1000 - x.disks.epoch > STALE_S);
  }

  // Worst level over every drive and RAID set in a disks.json server list (held servers left out).
  function worst(servers) {
    var lvl = 'ok';
    (servers || []).forEach(function (x) {
      var d = x.disks;
      if (!d || held(x)) return;
      (d.drives || []).concat(d.direct || []).forEach(function (dr) {
        var j = judge(dr).level;
        if (j === 'danger' || (j === 'caution' && lvl === 'ok')) lvl = j;
      });
      (d.vds || []).map(vdLevel).concat((d.enclosures || []).map(enclLevel)).forEach(function (j) {
        if (j === 'danger' || (j === 'caution' && lvl === 'ok')) lvl = j;
      });
      if (cacheWarn(d).length && lvl === 'ok') lvl = 'caution';
      var ms = missing(d);
      if (ms.vds.length || ms.enclosures.length || manyBad(d).length) lvl = 'danger';
    });
    return lvl;
  }

  root.DiskRules = {
    judge: judge, levels: levels, worst: worst, held: held, STALE_S: STALE_S, vdOk: vdOk, vdLevel: vdLevel, enclLevel: enclLevel, enclTemps: enclTemps,
    missing: missing, manyBad: manyBad, writePolicy: writePolicy, cacheRisks: cacheRisks, cacheWarn: cacheWarn, temp: temp, isSsd: isSsd,
    LIMITS: LIMITS, warmLimit: warmLimit, hotLimit: hotLimit,
    stateLabel: function (d) { var k = stateKey(d); return STATE_LABEL[k] || d.state || '—'; },
    vdLabel: function (v) { var k = String(v.state || '').toLowerCase(); return VD_LABEL[k] || v.state || '—'; },
    stateKey: stateKey
  };
})(window);
