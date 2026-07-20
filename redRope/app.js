'use strict';

const DEV_SKIP_BLE = false;

/* ============================================================
   Byte helpers
   ============================================================ */
function readU16LE(bytes, offset) { return bytes[offset] | (bytes[offset + 1] << 8); }
function readU32LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function parseTelemetry(payload) {
  return {
    state: payload[0],
    lengthM: readU16LE(payload, 1) / 10,
    rpm: readU16LE(payload, 3) / 10,
    traversePosMm: readU16LE(payload, 5),
    torqueStage: payload[7],
    torquePct: readU16LE(payload, 8) / 10,
  };
}

function parseAlarmRecord(payload) {
  const statusByte = payload[2];
  const kodBytes = payload.slice(13, 21);
  const kod = new TextDecoder('utf-8').decode(kodBytes).replace(/\0+$/, '').trim();
  return {
    sira: readU16LE(payload, 0),
    aktif: !!(statusByte & 0x01),
    kalici: !!(statusByte & 0x02),
    resetlenmis: !!(statusByte & 0x04),
    zaman: readU32LE(payload, 3),
    giderilme: readU32LE(payload, 7),
    olusSayisi: readU16LE(payload, 11), // aynı kod, kayıt açıkken kaç kez tekrar tetiklendi
    kod,
  };
}

function fmtEpoch(epoch) {
  if (!epoch) return '—';
  return new Date(epoch * 1000).toLocaleString('tr-TR');
}

/* ============================================================
   ALARM_CODE_INFO — bilinen LZ3A sürücü ve sistem alarm kodları
   ============================================================ */
const ALARM_CODE_INFO = {
  Err4: 'Aşırı Akım',
  Err6: 'Aşırı Gerilim',
  Err7: 'Düşük Gerilim',
  Err12: 'Motor Aşırı Yük',
  Err29: 'Enkoder Hatası',
  SLIP: 'Enkoder Kayma / Senkron Sapması',
};

/* ============================================================
   BleLink — GATT bağlantısı + özel ikili çerçeve protokolü
   [type(1B)][id_low(1B)][id_high(1B)][len(1B)][payload...][checksum(1B, XOR)]
   ============================================================ */
class BleLink {
  static SERVICE_UUID           = '7a2b0001-8f3c-4a6e-9d21-b1e5c2f30001'; // REDLIFT-ROPE servis UUID (değiştir)
  static TX_CHARACTERISTIC_UUID = '7a2b0001-8f3c-4a6e-9d21-b1e5c2f30002'; // Komut gönderme (değiştir)
  static RX_CHARACTERISTIC_UUID = '7a2b0001-8f3c-4a6e-9d21-b1e5c2f30003'; // Veri alma / notify (değiştir)
  static DEVICE_NAME_PREFIX = 'REDLIFT-ROPE';

  static TYPE_EMIR  = 0x01; // komut
  static TYPE_ISTEK = 0x02; // istek
  static TYPE_DURUM = 0x03; // anlık durum (unsolicited)
  static TYPE_YANIT = 0x04; // istek/emir yanıtı

  static CMD_START            = 0x0001;
  static CMD_PAUSE            = 0x0002;
  static CMD_STOP              = 0x0003;
  static CMD_ALARM_RESET      = 0x0004;
  static CMD_TRAVERSE_HOME    = 0x0005;
  static CMD_JOG_LEFT_START   = 0x0006;
  static CMD_JOG_RIGHT_START  = 0x0007;
  static CMD_JOG_STOP         = 0x0008;
  static CMD_YAZ_PARAMETRE    = 0x0009;

  static ISTEK_TUM_PARAMETRELER      = 0x0001;
  static ISTEK_ALARM_KAYIT_SAYISI    = 0x0002;
  static ISTEK_ALARM_KAYITLARI       = 0x0003;
  static ISTEK_SERVO_PARAMETRELERI   = 0x0004; // payload: [servo_id(1B)] — modbus üzerinden sürücüden tüm parametreleri oku

  static STATUS_TELEMETRY      = 0x0001;
  static STATUS_ALARM_CHANGED  = 0x0002;

  static YANIT_PARAMETRE                     = 0x0001;
  static YANIT_PARAMETRE_BITTI               = 0x0002;
  static YANIT_PARAMETRE_YAZILDI             = 0x0003;
  static YANIT_ALARM_KAYDI                   = 0x0004;
  static YANIT_ALARM_SAYISI                  = 0x0005;
  static YANIT_ALARM_KAYITLARI_BITTI         = 0x0006;
  static YANIT_SERVO_PARAMETRESI             = 0x0007; // payload: [servo_id(1B)][modbus_addr(2B LE)][deger(2B LE)]
  static YANIT_SERVO_PARAMETRELERI_BITTI     = 0x0008; // payload: [servo_id(1B)][toplam_sayi(2B LE)]

  static RECONNECT_RETRY_INTERVAL_MS = 4000;

  constructor({ onConnectionChange, onFrame }) {
    this.device = null;
    this.txChar = null;
    this.rxChar = null;
    this.connected = false;
    this.sendQueue = Promise.resolve();
    this._reconnectTimer = null;
    this.onConnectionChange = onConnectionChange || (() => {});
    this.onFrame = onFrame || (() => {});
  }

  async tryAutoReconnect() {
    if (!navigator.bluetooth || !navigator.bluetooth.getDevices) return false;
    const lastId = localStorage.getItem('redlift_last_device_id');
    if (!lastId) return false;
    try {
      const devices = await navigator.bluetooth.getDevices();
      const known = devices.find(d => d.id === lastId);
      if (!known) return false;
      await this.connectToDevice(known);
      return true;
    } catch (err) {
      console.warn('Oto-bağlantı başarısız:', err);
      this._scheduleReconnectRetry();
      return false;
    }
  }

  async requestAndConnect() {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: BleLink.DEVICE_NAME_PREFIX }],
      optionalServices: [BleLink.SERVICE_UUID],
    });
    await this.connectToDevice(device);
  }

  async connectToDevice(device) {
    this.device = device;
    device.addEventListener('gattserverdisconnected', () => this._onDisconnected());
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(BleLink.SERVICE_UUID);
    this.txChar = await service.getCharacteristic(BleLink.TX_CHARACTERISTIC_UUID);
    this.rxChar = await service.getCharacteristic(BleLink.RX_CHARACTERISTIC_UUID);
    await this.rxChar.startNotifications();
    this.rxChar.addEventListener('characteristicvaluechanged', (ev) => this._onNotify(ev));
    this.connected = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    localStorage.setItem('redlift_last_device_id', device.id);
    localStorage.setItem('redlift_last_device_name', device.name || '');
    this.onConnectionChange(true);
  }

  disconnect() {
    if (this.device && this.device.gatt && this.device.gatt.connected) {
      this.device.gatt.disconnect();
    }
  }

  _onDisconnected() {
    this.connected = false;
    this.txChar = null;
    this.rxChar = null;
    this.sendQueue = Promise.resolve();
    this.onConnectionChange(false);
    this._scheduleReconnectRetry();
  }

  _scheduleReconnectRetry() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (this.connected) return;
      const lastId = localStorage.getItem('redlift_last_device_id');
      if (!lastId) return;
      try {
        const devices = await navigator.bluetooth.getDevices();
        const known = devices.find(d => d.id === lastId);
        if (known) await this.connectToDevice(known);
        else this._scheduleReconnectRetry();
      } catch (err) {
        this._scheduleReconnectRetry();
      }
    }, BleLink.RECONNECT_RETRY_INTERVAL_MS);
  }

  _onNotify(ev) {
    const value = ev.target.value;
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const frame = BleLink._parseFrame(bytes);
    if (frame) this.onFrame(frame);
  }

  static _buildFrame(type, id, payload = []) {
    const len = payload.length;
    const bytes = [type, id & 0xff, (id >> 8) & 0xff, len, ...payload];
    let checksum = 0;
    for (const b of bytes) checksum ^= b;
    bytes.push(checksum);
    return new Uint8Array(bytes);
  }

  static _parseFrame(bytes) {
    if (bytes.length < 5) return null;
    const type = bytes[0];
    const id = bytes[1] | (bytes[2] << 8);
    const len = bytes[3];
    if (bytes.length < 4 + len + 1) return null;
    const payload = bytes.slice(4, 4 + len);
    let checksum = 0;
    for (let i = 0; i < 4 + len; i++) checksum ^= bytes[i];
    if (checksum !== bytes[4 + len]) {
      console.warn('BLE checksum hatası, çerçeve atlandı');
      return null;
    }
    return { type, id, payload };
  }

  _send(type, id, payload = []) {
    if (!this.txChar) return Promise.reject(new Error('Bağlı değil'));
    const frame = BleLink._buildFrame(type, id, payload);
    this.sendQueue = this.sendQueue
      .then(() => (this.txChar.writeValueWithoutResponse
        ? this.txChar.writeValueWithoutResponse(frame)
        : this.txChar.writeValue(frame)))
      .catch(err => console.warn('BLE gönderim hatası:', err));
    return this.sendQueue;
  }

  sendEmir(cmdId, payload = []) { return this._send(BleLink.TYPE_EMIR, cmdId, payload); }
  sendIstek(istekId, payload = []) { return this._send(BleLink.TYPE_ISTEK, istekId, payload); }

  writeParam(addr, value) {
    const payload = [addr & 0xff, (addr >> 8) & 0xff, value & 0xff, (value >> 8) & 0xff];
    return this.sendEmir(BleLink.CMD_YAZ_PARAMETRE, payload);
  }

  requestAllParams() { return this.sendIstek(BleLink.ISTEK_TUM_PARAMETRELER); }
  requestAlarmRecords() { return this.sendIstek(BleLink.ISTEK_ALARM_KAYITLARI); }
  requestServoParams(servoId) { return this.sendIstek(BleLink.ISTEK_SERVO_PARAMETRELERI, [servoId]); }
}

/* ============================================================
   Pager — yatay kaydırmalı sayfalar + alt sekme çubuğu senkronu
   ============================================================ */
class Pager {
  constructor(pagerEl, navEl) {
    this.pagerEl = pagerEl;
    this.navButtons = Array.from(navEl.querySelectorAll('.nav-tab'));
    this.current = 0;
    this.navButtons.forEach(btn => {
      btn.addEventListener('click', () => this.goToPage(parseInt(btn.dataset.page, 10)));
    });
    this.pagerEl.addEventListener('scroll', () => this._onScroll());
  }
  goToPage(index) {
    const page = this.pagerEl.children[index];
    if (!page) return;
    this.pagerEl.scrollTo({ left: page.offsetLeft, behavior: 'smooth' });
  }
  _onScroll() {
    const index = Math.round(this.pagerEl.scrollLeft / Math.max(this.pagerEl.clientWidth, 1));
    if (index !== this.current) {
      this.current = index;
      this.navButtons.forEach(btn => btn.classList.toggle('active', parseInt(btn.dataset.page, 10) === index));
    }
  }
}

/* ============================================================
   Parametre tanımları — register adresi <-> DOM elemanı <-> ölçek
   ============================================================ */
const PARAM_DEFS = [
  { addr: 1, elId: 'paramRopeDiameter', scale: 10 },
  { addr: 2, elId: 'paramTargetLength', scale: 10 },
  { addr: 3, elId: 'paramTraverseWidth', scale: 1 },
  { addr: 9, elId: 'paramSlipTolerance', scale: 10 },
];
const PARAM_BY_ADDR = new Map(PARAM_DEFS.map(d => [d.addr, d]));

const ADDR_TARGET_LENGTH = 2;
const ADDR_TRAVERSE_WIDTH = 3;
const ADDR_TORQUE_UNIT = 4;
const ADDR_TORQUE_STAGE_BASE = 5; // 5..8 -> kademe 1..4 için ayarlı Nm/% değeri
const ADDR_ACTIVE_TORQUE_STAGE = 10; // operatörün seçtiği çalışma kademesi (1..4)
const ADDR_WORK_RANGE_MIN = 11; // mm, home'a göre soft-limit alt sınır — TODO: Parametre ekranına UI eklenecek
const ADDR_WORK_RANGE_MAX = 12; // mm, home'a göre soft-limit üst sınır — TODO: Parametre ekranına UI eklenecek

/* ============================================================
   ParamsUI — Parametre ekranı: okuma, yazma, onay animasyonu
   ============================================================ */
class ParamsUI {
  constructor(ble, paramCache, onUpdate) {
    this.ble = ble;
    this.cache = paramCache;
    this.onUpdate = onUpdate || (() => {});
    this.pageEl = document.getElementById('page-1');
    this.pageEl.addEventListener('change', (ev) => {
      const el = ev.target.closest('[data-addr]');
      if (el) this._writeParam(el);
    });

    for (let stage = 1; stage <= 4; stage++) {
      document.getElementById('stageBtn' + stage).addEventListener('click', () => {
        this.cache.set(ADDR_ACTIVE_TORQUE_STAGE, stage);
        this.ble.writeParam(ADDR_ACTIVE_TORQUE_STAGE, stage);
        this._refreshTorqueButtons();
      });
    }
  }

  applyParamValue(addr, rawValue) {
    this.cache.set(addr, rawValue);
    this._refreshTorqueButtons();
    const def = PARAM_BY_ADDR.get(addr);
    if (!def) return;
    const el = document.getElementById(def.elId);
    if (!el) return;
    el.value = (rawValue / def.scale).toFixed(def.scale === 10 ? 1 : 0);
    this.onUpdate();
  }

  confirmWrite(addr, basarili) {
    const def = PARAM_BY_ADDR.get(addr);
    if (!def) return;
    const el = document.getElementById(def.elId);
    if (!el) return;
    if (basarili) {
      el.classList.remove('saved-flash');
      void el.offsetWidth; // reflow, animasyonu yeniden tetikle
      el.classList.add('saved-flash');
    } else {
      console.warn('Parametre yazma başarısız, addr=', addr);
    }
  }

  _refreshTorqueButtons() {
    const unit = this.cache.get(ADDR_TORQUE_UNIT);
    const active = this.cache.get(ADDR_ACTIVE_TORQUE_STAGE);
    for (let stage = 1; stage <= 4; stage++) {
      const raw = this.cache.get(ADDR_TORQUE_STAGE_BASE + (stage - 1));
      const valueEl = document.getElementById('stageBtnValue' + stage);
      if (valueEl && raw !== undefined) {
        const v = (raw / 10).toFixed(1);
        valueEl.textContent = unit === 1 ? ('%' + v) : (v + ' Nm');
      }
      const btnEl = document.getElementById('stageBtn' + stage);
      if (btnEl) btnEl.classList.toggle('active', active === stage);
    }
  }

  _writeParam(el) {
    const addr = parseInt(el.dataset.addr, 10);
    const def = PARAM_BY_ADDR.get(addr);
    if (!def) return;
    const parsed = parseFloat(el.value);
    if (Number.isNaN(parsed) || parsed < 0) {
      this.applyParamValue(addr, this.cache.get(addr) || 0);
      return;
    }
    const raw = Math.round(parsed * def.scale);
    this.cache.set(addr, raw);
    this.ble.writeParam(addr, raw);
    this.onUpdate();
  }

  requestAll() { this.ble.requestAllParams(); }
}

/* ============================================================
   HomeUI — Ana ekran: metraj, rpm, traverse, tork
   ============================================================ */
const RPM_DIAL_MAX = 150; // gösterge dolgusu için görsel referans üst sınır (sabit bir makine limiti değil)

function initRing(el) {
  const c = 2 * Math.PI * parseFloat(el.getAttribute('r'));
  el.style.strokeDasharray = String(c);
  el.style.strokeDashoffset = String(c);
  return c;
}

class HomeUI {
  constructor(ble, paramCache) {
    this.ble = ble;
    this.cache = paramCache;

    this.lengthValue = document.getElementById('lengthValue');
    this.targetValue = document.getElementById('targetValue');
    this.percentValue = document.getElementById('percentValue');
    this.percentBadge = document.getElementById('percentBadge');
    this.ringFill = document.getElementById('lengthRingFill');
    this.ringCircumference = initRing(this.ringFill);

    this.rpmValue = document.getElementById('rpmValue');
    this.rpmRingFill = document.getElementById('rpmRingFill');
    this.rpmRingCircumference = initRing(this.rpmRingFill);

    this.traversePosValue = document.getElementById('traversePosValue');
    this.traverseFill = document.getElementById('traverseFill');

    this.torqueStageLabel = document.getElementById('torqueStageLabel');
    this.torquePercent = document.getElementById('torquePercent');
    this.torqueNmSub = document.getElementById('torqueNmSub');
    this.torqueRingFill = document.getElementById('torqueRingFill');
    this.torqueRingCircumference = initRing(this.torqueRingFill);

    this._last = null;
  }

  render(t) {
    this._last = t;

    const targetRaw = this.cache.get(ADDR_TARGET_LENGTH);
    const targetM = targetRaw ? targetRaw / 10 : 0;
    const percent = targetM > 0 ? Math.min(100, (t.lengthM / targetM) * 100) : 0;

    this.lengthValue.textContent = t.lengthM.toFixed(2);
    this.targetValue.textContent = targetM.toFixed(2);
    this.percentValue.textContent = percent.toFixed(1);

    const reached = (t.state === 3 || percent >= 100);
    this.ringFill.style.strokeDashoffset = String(this.ringCircumference * (1 - percent / 100));
    this.ringFill.classList.toggle('reached', reached);
    this.percentBadge.classList.toggle('reached', reached);

    this.rpmValue.textContent = t.rpm.toFixed(1);
    const rpmPct = Math.min(100, Math.max(0, (t.rpm / RPM_DIAL_MAX) * 100));
    this.rpmRingFill.style.strokeDashoffset = String(this.rpmRingCircumference * (1 - rpmPct / 100));

    const widthRaw = this.cache.get(ADDR_TRAVERSE_WIDTH) || 0;
    this.traversePosValue.textContent = Math.round(t.traversePosMm);
    const posPct = widthRaw > 0 ? Math.min(100, Math.max(0, (t.traversePosMm / widthRaw) * 100)) : 0;
    this.traverseFill.style.width = posPct.toFixed(1) + '%';

    this.torqueStageLabel.textContent = 'K' + t.torqueStage;
    this.torquePercent.textContent = t.torquePct.toFixed(1);
    const torquePct = Math.min(100, Math.max(0, t.torquePct));
    this.torqueRingFill.style.strokeDashoffset = String(this.torqueRingCircumference * (1 - torquePct / 100));
    const unit = this.cache.get(ADDR_TORQUE_UNIT);
    const stageRaw = this.cache.get(ADDR_TORQUE_STAGE_BASE + (t.torqueStage - 1));
    if (stageRaw !== undefined && t.torqueStage >= 1 && t.torqueStage <= 4) {
      const stageVal = (stageRaw / 10).toFixed(1);
      this.torqueNmSub.textContent = unit === 0 ? `(${stageVal} Nm)` : `(%${stageVal})`;
    } else {
      this.torqueNmSub.textContent = '';
    }
  }

  refreshFromCache() {
    if (this._last) this.render(this._last);
  }
}

/* ============================================================
   JogUI — Manuel jog ekranı: basılı-tut sola/sağa hareket
   ============================================================ */
class JogUI {
  constructor(ble, paramCache) {
    this.ble = ble;
    this.cache = paramCache;
    this.posValue = document.getElementById('jogPosValue');
    this.flag = document.getElementById('jogFlag');
    this.needle = document.getElementById('jogNeedle');
    this.fill = document.getElementById('jogFill');
    this.left = document.getElementById('jogLeft');
    this.right = document.getElementById('jogRight');

    this._bindHold(this.left, BleLink.CMD_JOG_LEFT_START);
    this._bindHold(this.right, BleLink.CMD_JOG_RIGHT_START);

    document.getElementById('btnTraverseHome').addEventListener('click', () => {
      this.ble.sendEmir(BleLink.CMD_TRAVERSE_HOME);
    });

    this._last = null;
  }

  _bindHold(btn, startCmd) {
    const start = (ev) => {
      ev.preventDefault();
      if (btn.disabled) return;
      btn.classList.add('pressed');
      if (btn.setPointerCapture && ev.pointerId !== undefined) btn.setPointerCapture(ev.pointerId);
      this.ble.sendEmir(startCmd);
    };
    const stop = () => {
      if (!btn.classList.contains('pressed')) return;
      btn.classList.remove('pressed');
      this.ble.sendEmir(BleLink.CMD_JOG_STOP);
    };
    btn.addEventListener('pointerdown', start);
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointerleave', stop);
    btn.addEventListener('pointercancel', stop);
  }

  render(t) {
    this._last = t;
    const widthRaw = this.cache.get(ADDR_TRAVERSE_WIDTH) || 0;
    this.posValue.textContent = Math.round(t.traversePosMm);

    const posPct = widthRaw > 0 ? Math.min(100, Math.max(0, (t.traversePosMm / widthRaw) * 100)) : 0;
    const screenPct = Math.min(96, Math.max(4, 100 - posPct));
    this.fill.style.width = posPct.toFixed(1) + '%';
    this.flag.style.left = screenPct.toFixed(1) + '%';
    this.needle.style.left = screenPct.toFixed(1) + '%';

    const winding = (t.state === 1);
    this.left.disabled = winding;
    this.right.disabled = winding;
  }

  refreshFromCache() {
    if (this._last) this.render(this._last);
  }
}

/* ============================================================
   AlarmsUI — Alarm/hata ekranı: aktif + geçmiş kayıtlar
   ============================================================ */
class AlarmsUI {
  constructor(ble) {
    this.ble = ble;
    this.records = new Map(); // sira -> record
    this.tab = 'active';
    this.listEl = document.getElementById('alarmList');
    this.badgeEl = document.getElementById('alarmBadge');
    this.tabActive = document.getElementById('alarmTabActive');
    this.tabHistory = document.getElementById('alarmTabHistory');
    this.btnAlarmReset = document.getElementById('btnAlarmReset');

    this.tabActive.addEventListener('click', () => this._setTab('active'));
    this.tabHistory.addEventListener('click', () => this._setTab('history'));
    this.btnAlarmReset.addEventListener('click', () => this.ble.sendEmir(BleLink.CMD_ALARM_RESET));
  }

  _setTab(tab) {
    this.tab = tab;
    this.tabActive.classList.toggle('active', tab === 'active');
    this.tabHistory.classList.toggle('active', tab === 'history');
    this.btnAlarmReset.style.display = (tab === 'history') ? 'flex' : 'none';
    this.render();
  }

  upsert(record) {
    this.records.set(record.sira, record);
    this.render();
  }

  _isHistorical(r) {
    if (!r.aktif) return true;
    return r.kalici && r.resetlenmis && !r.aktif;
  }

  render() {
    const all = Array.from(this.records.values());
    const activeCount = all.filter(r => r.aktif).length;

    if (activeCount > 0) {
      this.badgeEl.style.display = 'block';
      this.badgeEl.className = 'nav-tab-badge';
    } else {
      this.badgeEl.style.display = 'none';
    }

    const shown = all
      .filter(r => (this.tab === 'active' ? r.aktif : !r.aktif))
      .sort((a, b) => b.zaman - a.zaman);

    if (shown.length === 0) {
      this.listEl.innerHTML = `<div class="alarm-empty">${this.tab === 'active' ? 'Aktif alarm yok' : 'Geçmiş kayıt yok'}</div>`;
      return;
    }

    this.listEl.innerHTML = shown.map(r => {
      const desc = ALARM_CODE_INFO[r.kod] || 'Tanımsız alarm kodu';
      const typeCls = r.aktif ? 'type-active' : 'type-history';
      const iconCls = r.aktif ? 'active' : 'cleared';
      const icon = r.aktif
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg>';
      const badge = r.aktif ? '<span class="alarm-badge">AKTİF</span>' : '';
      const tekrarSatiri = r.olusSayisi > 1 ? `<div class="alarm-occurrences">${r.olusSayisi} kez tekrarlandı</div>` : '';
      return `
        <div class="alarm-entry ${typeCls}">
          <div class="alarm-icon ${iconCls}">${icon}</div>
          <div class="alarm-body">
            <div class="alarm-code-row">
              <span class="alarm-code">${r.kod}</span>
              ${badge}
            </div>
            <div class="alarm-desc">${desc}</div>
            <div class="alarm-time">Başlangıç: ${fmtEpoch(r.zaman)}${r.giderilme ? ' · Giderildi: ' + fmtEpoch(r.giderilme) : ''}</div>
            ${tekrarSatiri}
          </div>
        </div>`;
    }).join('');
  }
}

/* ============================================================
   SystemUI — Sistem sayfası: servo sürücü Modbus parametre dökümü
   ============================================================ */
const SERVO_NAMES = { 1: 'Tambur Servo Sürücüsü', 2: 'Traverse Servo Sürücüsü' };

class SystemUI {
  constructor(ble) {
    this.ble = ble;
    this.records = new Map(); // modbus_addr -> value
    this.activeServoId = null;
    this.expectedCount = null;

    this.overlay = document.getElementById('servoOverlay');
    this.titleEl = document.getElementById('servoOverlayTitle');
    this.bodyEl = document.getElementById('servoOverlayBody');
    this.backBtn = document.getElementById('servoOverlayBack');

    this.backBtn.addEventListener('click', () => this._close());
    document.getElementById('servoBlock1').addEventListener('click', () => this._open(1));
    document.getElementById('servoBlock2').addEventListener('click', () => this._open(2));
  }

  _open(servoId) {
    this.activeServoId = servoId;
    this.records = new Map();
    this.expectedCount = null;
    this.titleEl.textContent = SERVO_NAMES[servoId] || ('Servo ' + servoId);
    this._renderLoading();
    this.overlay.classList.add('show');
    this.ble.requestServoParams(servoId);
  }

  _close() {
    this.overlay.classList.remove('show');
    this.activeServoId = null;
  }

  _renderLoading() {
    this.bodyEl.innerHTML = '<div class="servo-overlay-status"><div class="spinner"></div>Parametreler okunuyor...</div>';
  }

  onServoParam(servoId, addr, value) {
    if (servoId !== this.activeServoId) return;
    this.records.set(addr, value);
    this._render();
  }

  onServoParamsDone(servoId, count) {
    if (servoId !== this.activeServoId) return;
    this.expectedCount = count;
    this._render();
  }

  _render() {
    if (this.records.size === 0) { this._renderLoading(); return; }
    const rows = Array.from(this.records.entries()).sort((a, b) => a[0] - b[0]);
    const countLabel = this.expectedCount !== null
      ? `${rows.length} / ${this.expectedCount} parametre`
      : `${rows.length} parametre okundu...`;
    this.bodyEl.innerHTML = `<div class="servo-overlay-count">${countLabel}</div>` + rows.map(([addr, value]) => `
      <div class="servo-param-row">
        <span class="servo-param-addr">Reg ${addr}</span>
        <span class="servo-param-value">${value}</span>
      </div>`).join('');
  }
}

/* ============================================================
   RootApp — bağlantı, çerçeve yönlendirme, ekran orkestrasyonu
   ============================================================ */
class RootApp {
  constructor() {
    this.paramCache = new Map();
    this.lastTelemetry = null;

    this.ble = new BleLink({
      onConnectionChange: (c) => this._onConnectionChange(c),
      onFrame: (f) => this._onFrame(f),
    });

    this.pager = new Pager(document.getElementById('pager'), document.getElementById('bottomNav'));
    this.homeUI = new HomeUI(this.ble, this.paramCache);
    this.paramsUI = new ParamsUI(this.ble, this.paramCache, () => this._onParamsUpdated());
    this.jogUI = new JogUI(this.ble, this.paramCache);
    this.alarmsUI = new AlarmsUI(this.ble);
    this.systemUI = new SystemUI(this.ble);

    this.connLabel = document.getElementById('connLabel');
    this.connLed = document.getElementById('connLed');
    this.overlayMsg = document.getElementById('overlayMsg');
    this.overlayDeviceName = document.getElementById('overlayDeviceName');
    this.overlaySpinner = document.getElementById('overlaySpinner');
    this.btnManualConnect = document.getElementById('btnManualConnect');

    if (this.btnManualConnect) {
      this.btnManualConnect.addEventListener('click', () => this._manualConnect());
    }

    window.addEventListener('pagehide', () => this.ble.disconnect());

    this._init();
  }

  async _init() {
    if (DEV_SKIP_BLE) {
      document.body.classList.remove('ble-disconnected');
      this.connLabel.textContent = 'BLE yok (demo)';
      const idle = { state: 0, lengthM: 0, rpm: 0, traversePosMm: 0, torqueStage: 1, torquePct: 0 };
      this.lastTelemetry = idle;
      this.homeUI.render(idle);
      this.jogUI.render(idle);
      return;
    }
    document.body.classList.add('ble-disconnected');
    this._setConnectingUI(true, 'Kayıtlı cihaz aranıyor...');
    const reconnected = await this.ble.tryAutoReconnect();
    if (!reconnected) {
      this._setConnectingUI(false, 'Kayıtlı cihaz bulunamadı.');
    }
  }

  async _manualConnect() {
    try {
      this._setConnectingUI(true, 'Cihaz seçimi bekleniyor...');
      await this.ble.requestAndConnect();
    } catch (err) {
      this._setConnectingUI(false, 'Bağlantı hatası: ' + err.message);
    }
  }

  _setConnectingUI(isConnecting, message) {
    this.overlayMsg.textContent = message;
    this.overlaySpinner.style.display = isConnecting ? 'inline-block' : 'none';
    if (this.btnManualConnect) this.btnManualConnect.style.display = isConnecting ? 'none' : 'flex';
  }

  _onConnectionChange(connected) {
    if (connected) {
      document.body.classList.remove('ble-disconnected');
      this.connLed.classList.add('on');
      this.connLabel.textContent = localStorage.getItem('redlift_last_device_name') || 'Bağlı';
      this.ble.requestAllParams();
      this.ble.requestAlarmRecords();
    } else {
      document.body.classList.add('ble-disconnected');
      this.connLed.classList.remove('on');
      this.connLabel.textContent = 'Bağlantı yok';
      this.overlayDeviceName.textContent = localStorage.getItem('redlift_last_device_name') || '';
      this._setConnectingUI(true, 'Bağlantı koptu, yeniden bağlanılıyor...');
    }
  }

  _onParamsUpdated() {
    this.homeUI.refreshFromCache();
    this.jogUI.refreshFromCache();
  }

  _onFrame(frame) {
    const { type, id, payload } = frame;

    if (type === BleLink.TYPE_DURUM) {
      if (id === BleLink.STATUS_TELEMETRY) {
        const t = parseTelemetry(payload);
        this.lastTelemetry = t;
        this.homeUI.render(t);
        this.jogUI.render(t);
      } else if (id === BleLink.STATUS_ALARM_CHANGED) {
        this.alarmsUI.upsert(parseAlarmRecord(payload));
      }
      return;
    }

    if (type === BleLink.TYPE_YANIT) {
      switch (id) {
        case BleLink.YANIT_PARAMETRE: {
          const addr = readU16LE(payload, 0);
          const value = readU16LE(payload, 2);
          this.paramsUI.applyParamValue(addr, value);
          break;
        }
        case BleLink.YANIT_PARAMETRE_YAZILDI: {
          const addr = readU16LE(payload, 0);
          const basarili = !!payload[2];
          this.paramsUI.confirmWrite(addr, basarili);
          break;
        }
        case BleLink.YANIT_ALARM_KAYDI:
          this.alarmsUI.upsert(parseAlarmRecord(payload));
          break;
        case BleLink.YANIT_SERVO_PARAMETRESI: {
          const servoId = payload[0];
          const addr = readU16LE(payload, 1);
          const value = readU16LE(payload, 3);
          this.systemUI.onServoParam(servoId, addr, value);
          break;
        }
        case BleLink.YANIT_SERVO_PARAMETRELERI_BITTI: {
          const servoId = payload[0];
          const count = readU16LE(payload, 1);
          this.systemUI.onServoParamsDone(servoId, count);
          break;
        }
        case BleLink.YANIT_PARAMETRE_BITTI:
        case BleLink.YANIT_ALARM_SAYISI:
        case BleLink.YANIT_ALARM_KAYITLARI_BITTI:
          break;
      }
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.redRopeApp = new RootApp();
});
