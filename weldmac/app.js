// =====================================================================
// PAGER — yatay kaydırma + nokta senkronizasyonu
// =====================================================================
class Pager {
  constructor(pagerEl, dotsContainerEl) {
    this.pager = pagerEl;
    this.dots = Array.from(dotsContainerEl.querySelectorAll('.dot'));
    this.dots.forEach(dot => {
      dot.addEventListener('click', () => this.goToPage(Number(dot.dataset.page)));
    });

    let scrollTimeout;
    this.pager.addEventListener('scroll', () => {
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        const index = Math.round(this.pager.scrollLeft / this.pager.clientWidth);
        this.dots.forEach((d, i) => d.classList.toggle('active', i === index));
      }, 60);
    });
  }

  goToPage(index) {
    // clientWidth kullanılıyor çünkü scroll listener'daki aktif-sayfa hesabı da
    // aynı birimi kullanıyor (scrollLeft / clientWidth) — offsetLeft, flex
    // genişliklerindeki yuvarlama farkları yüzünden bundan sapıp snap'in bir
    // komşu sayfaya kaymasına yol açabiliyordu.
    this.pager.scrollTo({ left: index * this.pager.clientWidth, behavior: 'smooth' });
  }
}

// =====================================================================
// BAĞLANTI UI — durum LED'i, fallback buton, RX/TX flaş efekti
// =====================================================================
class ConnUI {
  constructor(statusLedEl, fallbackBtnEl, txLedEl, rxLedEl) {
    this.statusLed = statusLedEl;
    this.fallbackBtn = fallbackBtnEl;
    this.txLed = txLedEl;
    this.rxLed = rxLedEl;
  }

  update(connected) {
    this.statusLed.classList.toggle('on', connected);
    this.fallbackBtn.classList.toggle('show', !connected);
  }

  flashTx() { this._flash(this.txLed); }
  flashRx() { this._flash(this.rxLed); }

  _flash(led) {
    led.classList.add('flash');
    clearTimeout(led._t);
    led._t = setTimeout(() => led.classList.remove('flash'), 120);
  }
}

// =====================================================================
// BLE — OTOMATİK YENİDEN BAĞLANMA + GÖNDER/AL + FRAME OLUŞTURMA/PARSE
// =====================================================================
class BleLink {
  static SERVICE_UUID           = '12345678-1234-1234-1234-123456789abd'; // WELDMAC servis UUID (değiştir)
  static TX_CHARACTERISTIC_UUID = 'abcd1234-ab12-cd34-ef56-abcdef123457'; // Komut gönderme (değiştir)
  static RX_CHARACTERISTIC_UUID = 'abcd1234-ab12-cd34-ef56-abcdef123458'; // Veri alma / notify (değiştir)

  // ===== PAKET TİPLERİ =====
  static TYPE_EMIR   = 0x01;
  static TYPE_ISTEK  = 0x02;
  static TYPE_DURUM  = 0x03;
  static TYPE_YANIT  = 0x04;

  // ===== EMIR ID'leri =====
  static CMD_PREHEAT_START = 0x0001;
  static CMD_PROCESS_START = 0x0002;
  static CMD_STOP          = 0x0003;

  // ===== DURUM ID'leri =====
  static STATUS_SICAKLIK    = 0x0001;
  static STATUS_FAZ_DEGISTI = 0x0002;

  // ===== İSTEK ID'leri (TYPE_ISTEK ile gönderilir) =====
  static ISTEK_ENDA_SAYISI = 0x0001;

  // ===== YANIT ID'leri (TYPE_YANIT ile gelir) =====
  static YANIT_ENDA_SAYISI = 0x0001;

  constructor({ onConnectionChange, onFrame, onTx, onRx }) {
    this.device = null;
    this.txCharacteristic = null;
    this.rxCharacteristic = null;
    this.connected = false;
    this.onConnectionChange = onConnectionChange;
    this.onFrame = onFrame;
    this.onTx = onTx;
    this.onRx = onRx;
  }

  async connectToDevice(device) {
    try {
      device.addEventListener('gattserverdisconnected', () => this._onDisconnected());
      const server  = await device.gatt.connect();
      const service = await server.getPrimaryService(BleLink.SERVICE_UUID);

      this.txCharacteristic = await service.getCharacteristic(BleLink.TX_CHARACTERISTIC_UUID);
      this.rxCharacteristic = await service.getCharacteristic(BleLink.RX_CHARACTERISTIC_UUID);

      await this.rxCharacteristic.startNotifications();
      this.rxCharacteristic.addEventListener('characteristicvaluechanged', (e) => this._handleIncomingData(e));

      this.device = device;
      this.connected = true;
      this.onConnectionChange(true);
    } catch (err) {
      console.error('Bağlantı hatası:', err);
      this.connected = false;
      this.onConnectionChange(false);
    }
  }

  async tryAutoReconnect() {
    const savedId = localStorage.getItem('redlift_last_device_id');
    if (!savedId || !navigator.bluetooth.getDevices) {
      this.onConnectionChange(this.connected);
      return;
    }
    try {
      const knownDevices = await navigator.bluetooth.getDevices();
      const match = knownDevices.find(d => d.id === savedId);
      if (match) {
        await this.connectToDevice(match);
      } else {
        this.onConnectionChange(this.connected);
      }
    } catch (err) {
      console.error('Otomatik bağlantı hatası:', err);
      this.onConnectionChange(this.connected);
    }
  }

  async requestDevice() {
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'REDLIFT-WELD' }],
        optionalServices: [BleLink.SERVICE_UUID]
      });
      localStorage.setItem('redlift_last_device_id', device.id);
      await this.connectToDevice(device);
    } catch (err) {
      console.error('Bağlantı hatası:', err);
    }
  }

  disconnect() {
    if (this.device && this.device.gatt.connected) {
      this.device.gatt.disconnect();
    }
  }

  _onDisconnected() {
    this.connected = false;
    this.txCharacteristic = null;
    this.rxCharacteristic = null;
    this.onConnectionChange(false);
  }

  _buildFrame(type, id, payload = []) {
    const idLow  = id & 0xFF;
    const idHigh = (id >> 8) & 0xFF;
    const len    = payload.length;
    const frame  = [type, idLow, idHigh, len, ...payload];
    let checksum = 0;
    for (const b of frame) checksum ^= b;
    frame.push(checksum);
    return frame;
  }

  _parseFrame(bytes) {
    if (bytes.length < 5) return null;
    const type = bytes[0];
    const id   = bytes[1] | (bytes[2] << 8);
    const len  = bytes[3];
    const payload = bytes.slice(4, 4 + len);
    const receivedChecksum = bytes[4 + len];

    let checksum = 0;
    for (let i = 0; i < 4 + len; i++) checksum ^= bytes[i];

    if (checksum !== receivedChecksum) {
      console.warn('Checksum hatası, paket atlandı:', bytes);
      return null;
    }
    return { type, id, payload };
  }

  async _send(type, id, payload = []) {
    if (!this.connected || !this.txCharacteristic) return;
    try {
      const frame = this._buildFrame(type, id, payload);
      await this.txCharacteristic.writeValue(new Uint8Array(frame));
      this.onTx && this.onTx();
    } catch (err) {
      console.error('Gönderme hatası:', err);
    }
  }

  sendEmir(cmdId, payload = []) {
    return this._send(BleLink.TYPE_EMIR, cmdId, payload);
  }

  // Ekranda ENDA paneli yokken ESP'ye "kaç ENDA bağlı" diye sorar.
  requestEndaCount() {
    return this._send(BleLink.TYPE_ISTEK, BleLink.ISTEK_ENDA_SAYISI);
  }

  _handleIncomingData(event) {
    this.onRx && this.onRx();
    const value = event.target.value;
    const bytes = [];
    for (let i = 0; i < value.byteLength; i++) bytes.push(value.getUint8(i));

    const frame = this._parseFrame(bytes);
    if (!frame) return;
    this.onFrame(frame);
  }
}

// =====================================================================
// EUP1222 REGISTER TANIMLARI (kaynak: ENDA EUP1222 kullanım kılavuzu, 29.07.2024)
// =====================================================================

// ---- HOLDING REGISTERS: temel/sistem parametreleri (profil adımları hariç) ----
const HOLDING_BASE = [
  { addr:0x0000, param:'H0',  tr:'Kontrol çıkışı sıcaklık set değeri',            unit:'°C', def:400 },
  { addr:0x0001, param:'H1',  tr:'Kontrol çıkışı 2. sıcaklık set değeri',         unit:'°C', def:500 },
  { addr:0x0002, param:'H2',  tr:'Kontrol çıkışı minimum set değeri limiti',      unit:'°C', def:-30 },
  { addr:0x0003, param:'H3',  tr:'Kontrol çıkışı maksimum set değeri limiti',     unit:'°C', def:600 },
  { addr:0x0004, param:'H4',  tr:'Oransal bant (Pb) — %0.0 ise On-Off kontrol',   unit:'%',  def:4.0 },
  { addr:0x0005, param:'H5',  tr:'Histerisiz değeri',                            unit:'°C', def:2 },
  { addr:0x0006, param:'H6',  tr:'İntegral zamanı',                              unit:'dk', def:4.0 },
  { addr:0x0007, param:'H7',  tr:'Türev zamanı',                                 unit:'dk', def:1.00 },
  { addr:0x0008, param:'H8',  tr:'Kontrol periyodu',                             unit:'sn', def:1 },
  { addr:0x0009, param:'H9',  tr:'Set değerindeki enerji yüzdesi',               unit:'%',  def:0 },
  { addr:0x000A, param:'H10', tr:'Sensör hatasında kontrol enerji yüzdesi',      unit:'%',  def:0 },
  { addr:0x000B, param:'H11', tr:'Soft-start zamanı',                            unit:'dk', def:0 },
  { addr:0x000C, param:'H12', tr:'Alarm1 sıcaklık set değeri',                   unit:'°C', def:500 },
  { addr:0x000D, param:'H13', tr:'Alarm1 minimum set değeri limiti',             unit:'°C', def:-30 },
  { addr:0x000E, param:'H14', tr:'Alarm1 maksimum set değeri limiti',            unit:'°C', def:600 },
  { addr:0x000F, param:'H15', tr:'Alarm1 oransal bant',                          unit:'%',  def:0.0 },
  { addr:0x0010, param:'H16', tr:'Alarm1 histerisiz değeri',                     unit:'°C', def:2 },
  { addr:0x0011, param:'H17', tr:'Alarm1 integral zamanı',                       unit:'dk', def:0.0 },
  { addr:0x0012, param:'H18', tr:'Alarm1 türev zamanı',                         unit:'dk', def:0.00 },
  { addr:0x0013, param:'H19', tr:'Alarm1 periyod zamanı',                        unit:'sn', def:1 },
  { addr:0x0014, param:'H20', tr:'Alarm1 set değerindeki enerji yüzdesi',        unit:'%',  def:0 },
  { addr:0x0015, param:'H21', tr:'Sensör hatasında Alarm1 enerji yüzdesi',       unit:'%',  def:0 },
  { addr:0x0016, param:'H22', tr:'Alarm1 tipi (0:Bağımsız 1:Sapma 2:Band 3:Band-sonrası 4:Bağımsız soğutma 5:Bağıl soğutma)', unit:'', def:0 },
  { addr:0x0017, param:'H23', tr:'Alarm2 sıcaklık set değeri',                   unit:'°C', def:500 },
  { addr:0x0018, param:'H24', tr:'Alarm2 minimum set değeri limiti',             unit:'°C', def:-30 },
  { addr:0x0019, param:'H25', tr:'Alarm2 maksimum set değeri limiti',            unit:'°C', def:600 },
  { addr:0x001A, param:'H26', tr:'Alarm2 histerisiz değeri',                     unit:'°C', def:2 },
  { addr:0x001B, param:'H27', tr:'Alarm2 tipi (0:Bağımsız 1:Sapma 2:Band 3:Band-sonrası)', unit:'', def:0 },
  { addr:0x001C, param:'H28', tr:'Giriş (sensör) tipi', unit:'', def:3,
    options:['PT100 ondalıklı','PT100','J ondalıklı','J','K ondalıklı','K','L ondalıklı','L','T ondalıklı','T','S','R','0-20mA','4-20mA','0-10V','2-10V','0-25mV','0-50mV'] },
  { addr:0x001D, param:'H29', tr:'Isıtma hata kontrol zamanı (0=kapalı)',        unit:'sn', def:60 },
  { addr:0x001E, param:'H30', tr:'Modbus haberleşme hızı', unit:'', def:2,
    options:['2400 bps','4800 bps','9600 bps','19200 bps','38400 bps','57200 bps','115200 bps'] },
  { addr:0x001F, param:'H31', tr:'Sayısal filtre katsayısı (1=devre dışı)',      unit:'',   def:20 },
  { addr:0x0020, param:'H32', tr:'Kontrol çıkışı seçimi', unit:'', def:0,
    options:['C/A2 (Röle)','SSR','SSR/ANL 0-20mA','SSR/ANL 4-20mA'] },
  { addr:0x0021, param:'H33', tr:'Analog çıkış minimum yüzde',                   unit:'%',  def:0 },
  { addr:0x0022, param:'H34', tr:'Analog çıkış maksimum yüzde',                  unit:'%',  def:100 },
  { addr:0x0023, param:'H35', tr:'Offset değeri',                                unit:'',   def:0 },
  { addr:0x0027, param:'H39', tr:'Manuel kontrol çıkış yüzdesi',                 unit:'%',  def:50 },
  { addr:0x0028, param:'H40', tr:'D1 dijital giriş kontrol modu', unit:'', def:0,
    options:['Kullanılmaz','H0/H1 set seçimi','Auto/Manuel','Termostat/Gösterge','Profil start/stop','Hold off/on'] },
  { addr:0x0029, param:'H41', tr:'D2 dijital giriş kontrol modu', unit:'', def:0,
    options:['Kullanılmaz','H0/H2 set seçimi','Auto/Manuel','Termostat/Gösterge','Profil start/stop','Hold off/on'] },
  { addr:0x002A, param:'H42', tr:'Retransmisyon çıkışı modu (H32=0 olmalı)', unit:'', def:0,
    options:['Kapalı','0-20mA','4-20mA'] },
  { addr:0x002B, param:'H43', tr:'Retransmisyon alt skala değeri',               unit:'',   def:-30 },
  { addr:0x002C, param:'H44', tr:'Retransmisyon üst skala değeri',               unit:'',   def:600 },
  { addr:0x002D, param:'H45', tr:'mA/V girişi ondalık nokta ayarı', unit:'', def:0,
    options:['Kapalı','0.0','0.00','0.000'] },
  { addr:0x002E, param:'H46', tr:'mA/V girişi kullanıcı alt skala',              unit:'',   def:-1999 },
  { addr:0x002F, param:'H47', tr:'mA/V girişi kullanıcı üst skala',              unit:'',   def:2000 },
  { addr:0x0030, param:'H48', tr:'Modbus cihaz adresi',                          unit:'',   def:1 },
  { addr:0x0034, param:'H52', tr:'RS485 sinyal kaybında çıkış-off zamanı (C11=1 gerekli)', unit:'sn', def:2 },
  { addr:0x0064, param:'H100', tr:'Profil zaman bazı', unit:'', def:0, options:['saniye','dakika'] },
  { addr:0x0065, param:'H101', tr:'Maksimum adım sayısı (0=timer/termostat modu)', unit:'', def:8 },
  { addr:0x0066, param:'H102', tr:'Adım sonu sıcaklık farkı toleransı',          unit:'°C', def:5 },
  { addr:0x0087, param:'H135', tr:'Termostat modunda adım zaman değeri',        unit:'sn', def:30 },
];

// ---- HOLDING REGISTERS: 16 adımlık profil (H103..H134 örüntüsü) ----
function getProfileStepRegs(step) { // step: 1..16
  const base = 0x0067 + (step - 1) * 2; // H103 + (step-1)*2
  return {
    target: { addr: base,     param: `H${103 + (step-1)*2}`, tr: `${step}. Adım hedef sıcaklık`, unit:'°C' },
    time:   { addr: base + 1, param: `H${104 + (step-1)*2}`, tr: `${step}. Adım zaman değeri`,    unit:'sn' },
  };
}

// ---- COIL REGISTERS: temel/sistem bitleri ----
const COIL_BASE = [
  { addr:0x0000, param:'C0',  tr:'Alarm2 durumu', options:['Set altında aktif','Set üstünde aktif'] },
  { addr:0x0001, param:'C1',  tr:'Prob arızasında Alarm2 konumu', options:['Off','On'] },
  { addr:0x0002, param:'C2',  tr:'Alarm1 durumu', options:['Set altında aktif','Set üstünde aktif'] },
  { addr:0x0003, param:'C3',  tr:'Prob arızasında Alarm1 konumu', options:['Off','On'] },
  { addr:0x0004, param:'C4',  tr:'Kontrol çıkışı konfigürasyonu', options:['Isıtma','Soğutma'] },
  { addr:0x0005, param:'C5',  tr:'Sıcaklık birimi', options:['°C','°F'] },
  { addr:0x0006, param:'C6',  tr:'Kontrol çıkışlarının durumu', options:['Gösterge modu (kapalı)','Aktif'] },
  { addr:0x0007, param:'C7',  tr:'2. sıcaklık set değerine göre kontrol', options:['H0 kullan','H1 kullan'] },
  { addr:0x0008, param:'C8',  tr:'Manuel kontrol biti', options:['Otomatik','Manuel (H39 yüzdesi)'] },
  { addr:0x0009, param:'C9',  tr:'Prob hatasında kontrol biçimi', options:['H10 % oranı','Son oransal değer'] },
  { addr:0x000A, param:'C10', tr:'Self tune kontrolü', options:['Durdur','Başlat'] },
  { addr:0x000B, param:'C11', tr:'RS485 bağlantı kopma hatası kontrolü', options:['Kapalı','Açık'] },
  { addr:0x0084, param:'C132', tr:'Kontrol modu seçimi', options:['Termostat modu','Profil kontrol modu'] },
  { addr:0x0085, param:'C133', tr:'Profil start/stop', options:['Durdur (1. adıma dön)','Start'] },
  { addr:0x0086, param:'C134', tr:'Profil hold', options:['Çalışmayı sürdür','Hold (beklet)'] },
  { addr:0x0087, param:'C135', tr:'Profil bitince davranış', options:['Kontrolü bitir','Son set değeriyle devam et'] },
  { addr:0x0088, param:'C136', tr:'Enerji kesilmesinde davranış', options:['1. adıma dön','Kaldığı yerden devam et'] },
  { addr:0x0089, param:'C137', tr:'A1 çıkış kontrol kaynağı', options:['H22 parametresi','Her adımda (H135)'] },
  { addr:0x008A, param:'C138', tr:'A2 çıkış kontrol kaynağı', options:['H27 parametresi','Her adımda (H136)'] },
];

function getProfileStepCoils(step) { // step: 1..16
  return {
    a1:  { addr: 0x0064 + (step - 1), param: `C${100 + (step-1)}`, tr: `${step}. Adım A1 alarm çıkışı`, options:['Kapalı','Açık'] },
    ca2: { addr: 0x0074 + (step - 1), param: `C${116 + (step-1)}`, tr: `${step}. Adım C/A2 alarm çıkışı`, options:['Kapalı','Açık'] },
  };
}

// ---- INPUT REGISTERS (salt okunur) ----
const INPUT_REGS = [
  { addr:0x0000, param:'I0',   tr:'Ölçülen sıcaklık', unit:'°C' },
  { addr:0x0001, param:'I1',   tr:'Analog çıkış yüzdesi', unit:'%' },
  { addr:0x0002, param:'I2',   tr:'Ölçme hata kodu (0:Yok 1:Kısa devre 2:Alt skala 3:Üst skala 4:Kopuk 5:Kalibrasyon)', unit:'' },
  { addr:0x0003, param:'I3',   tr:'Self tune durum kodu', unit:'' },
  { addr:0x0004, param:'I4',   tr:'Aktif sıcaklık set değeri', unit:'°C' },
  { addr:0x0005, param:'I5',   tr:'Aktif ondalık nokta değeri', unit:'' },
  { addr:0x0064, param:'I100', tr:'Aktif adım numarası', unit:'' },
  { addr:0x0065, param:'I101', tr:'Aktif adımın kalan zamanı', unit:'sn' },
  { addr:0x0066, param:'I102', tr:'Aktif adımın hedef sıcaklığı', unit:'°C' },
];

// ---- DISCRETE REGISTERS (salt okunur) ----
const DISCRETE_REGS = [
  { addr:0x0000, param:'D0',   tr:'C/A2 kontrol çıkışı durumu' },
  { addr:0x0001, param:'D1',   tr:'A1 çıkışı durumu' },
  { addr:0x0002, param:'D2',   tr:'SSR çıkışı durumu' },
  { addr:0x0003, param:'D3',   tr:'D1 dijital giriş durumu' },
  { addr:0x0004, param:'D4',   tr:'D2 dijital giriş durumu' },
  { addr:0x0005, param:'D5',   tr:'Isıtma hatası durumu' },
  { addr:0x0064, param:'D100', tr:'Profil sabit sıcaklık adımında' },
  { addr:0x0065, param:'D101', tr:'Profil ısıtma adımında' },
  { addr:0x0066, param:'D102', tr:'Profil soğutma adımında' },
  { addr:0x0067, param:'D103', tr:'Profil sonlandı' },
  { addr:0x0068, param:'D104', tr:'Adım zamanlayıcısı 0 oldu' },
  { addr:0x0069, param:'D105', tr:'Adım zamanlayıcısı çalışıyor' },
];

// ---- "TEMEL" sekmesi için küçük, kürate edilmiş liste ----
const TEMEL_PARAMS_ADDR = [0x0000, 0x0004, 0x0006, 0x0007, 0x0008, 0x000C, 0x0014, 0x001C, 0x001E, 0x0030];
const TEMEL_COILS_ADDR  = [0x0004, 0x0005, 0x000A];

// =====================================================================
// AYARLAR SAYFASI — parametre/coil satırlarını render eder, sekme ve
// adım seçici davranışını yönetir
// =====================================================================
class SettingsUI {
  constructor() {
    this._bindStepSelector();
    this._bindTabs();
    this.renderTemelTab();
    this.renderReadonlyTab();
    this.renderAllTab();
  }

  renderParamRow(p, isCoil) {
    const inputHtml = p.options
      ? `<select class="param-select" data-addr="${p.addr}" data-coil="${!!isCoil}">
          ${p.options.map((opt, i) => `<option value="${i}" ${i === p.def ? 'selected' : ''}>${opt}</option>`).join('')}
        </select>`
      : `<input class="param-input" type="number" data-addr="${p.addr}" data-coil="${!!isCoil}" value="${p.def ?? ''}" />`;

    return `<div class="param-row">
      ${this._renderInfoBtn(p)}
      <span class="param-label">${p.tr}${p.unit ? ' (' + p.unit + ')' : ''}<span class="param-addr">${p.param} · 0x${p.addr.toString(16).toUpperCase().padStart(4,'0')}</span></span>
      ${inputHtml}
    </div>`;
  }

  renderReadonlyRow(p) {
    return `<div class="param-row">
      ${this._renderInfoBtn(p)}
      <span class="param-label">${p.tr}${p.unit ? ' (' + p.unit + ')' : ''}<span class="param-addr">${p.param} · 0x${p.addr.toString(16).toUpperCase().padStart(4,'0')}</span></span>
      <span class="param-value-readonly" id="ro-${p.param}">--</span>
    </div>`;
  }

  _renderInfoBtn(p) {
    const info = encodeURIComponent(JSON.stringify({
      param: p.param, addr: p.addr, tr: p.tr, unit: p.unit, def: p.def, options: p.options,
    }));
    return `<button class="param-info-btn" data-info="${info}" aria-label="Parametre bilgisi">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="16" x2="12" y2="12"/>
        <line x1="12" y1="8" x2="12.01" y2="8"/>
      </svg>
    </button>`;
  }

  renderTemelTab() {
    const holdingRows = HOLDING_BASE.filter(p => TEMEL_PARAMS_ADDR.includes(p.addr)).map(p => this.renderParamRow(p, false)).join('');
    const coilRows = COIL_BASE.filter(p => TEMEL_COILS_ADDR.includes(p.addr)).map(p => this.renderParamRow(p, true)).join('');
    document.getElementById('panel-temel').innerHTML =
      `<div class="section-header">Sıcaklık &amp; PID</div>${holdingRows}<div class="section-header">Sistem</div>${coilRows}`;
  }

  renderReadonlyTab() {
    const inputRows = INPUT_REGS.map(p => this.renderReadonlyRow(p)).join('');
    const discreteRows = DISCRETE_REGS.map(p => this.renderReadonlyRow(p)).join('');
    document.getElementById('panel-readonly').innerHTML =
      `<div class="section-header">Input Registers</div>${inputRows}<div class="section-header">Discrete Registers</div>${discreteRows}`;
  }

  renderAllTab() {
    const holdingRows = HOLDING_BASE.map(p => this.renderParamRow(p, false)).join('');
    const coilRows = COIL_BASE.filter(p => p.addr < 0x0064).map(p => this.renderParamRow(p, true)).join('');
    document.getElementById('allParamsContainer').innerHTML =
      `<div class="section-header">Holding Registers</div>${holdingRows}<div class="section-header">Coil Registers</div>${coilRows}`;

    const profCoilRows = COIL_BASE.filter(p => p.addr >= 0x0084).map(p => this.renderParamRow(p, true)).join('');
    document.getElementById('profileControlContainer').innerHTML = profCoilRows;

    this.renderStepFields(1);
  }

  renderStepFields(step) {
    const regs = getProfileStepRegs(step);
    const coils = getProfileStepCoils(step);
    document.getElementById('stepFieldsContainer').innerHTML = [
      this.renderParamRow({ ...regs.target, def: 200 }, false),
      this.renderParamRow({ ...regs.time, def: 60 }, false),
      this.renderParamRow({ ...coils.a1, def: 0 }, true),
      this.renderParamRow({ ...coils.ca2, def: 0 }, true),
    ].join('');
  }

  _bindStepSelector() {
    const selector = document.getElementById('stepSelector');
    for (let i = 1; i <= 16; i++) {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `Adım ${i}`;
      selector.appendChild(opt);
    }
    selector.addEventListener('change', () => this.renderStepFields(Number(selector.value)));
  }

  _bindTabs() {
    document.querySelectorAll('.settings-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('panel-temel').style.display = tab.dataset.tab === 'temel' ? 'flex' : 'none';
        document.getElementById('panel-readonly').style.display = tab.dataset.tab === 'readonly' ? 'flex' : 'none';
        document.getElementById('panel-all').style.display = tab.dataset.tab === 'all' ? 'flex' : 'none';
      });
    });
  }
}

// =====================================================================
// ENDA PARAMETRELERİ OVERLAY — tam ekran panel, ENDA modülündeki dişli
// butonuna basılınca açılır
// =====================================================================
class SettingsOverlay {
  constructor(overlayEl, titleEl, closeBtnEl) {
    this.overlay = overlayEl;
    this.title = titleEl;
    closeBtnEl.addEventListener('click', () => this.close());
  }

  open(endaIndex) {
    this.title.textContent = `ENDA ${endaIndex} PARAMETRELERİ`;
    this.overlay.classList.add('show');
  }

  close() {
    this.overlay.classList.remove('show');
  }
}

// =====================================================================
// PARAMETRE BİLGİ MESAJI — parametre satırındaki info ikonuna basılınca
// açıklama/birim/varsayılan/seçenekleri gösterir
// =====================================================================
class ParamInfoModal {
  constructor(overlayEl, titleEl, bodyEl, closeBtnEl) {
    this.overlay = overlayEl;
    this.title = titleEl;
    this.body = bodyEl;

    closeBtnEl.addEventListener('click', () => this.close());
    overlayEl.addEventListener('click', (e) => {
      if (e.target === overlayEl) this.close();
    });
  }

  open(data) {
    this.title.textContent = `${data.param} · 0x${data.addr.toString(16).toUpperCase().padStart(4, '0')}`;

    const rows = [];
    if (data.def !== undefined && data.def !== null) {
      rows.push(['Varsayılan', `${data.def}${data.unit ? ' ' + data.unit : ''}`]);
    } else if (data.unit) {
      rows.push(['Birim', data.unit]);
    }
    if (data.options) rows.push(['Seçenekler', data.options.join(', ')]);

    this.body.innerHTML = `
      <div class="param-info-desc">${data.tr}</div>
      ${rows.map(([k, v]) => `<div class="info-popup-row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('')}
    `;
    this.overlay.classList.add('show');
  }

  close() {
    this.overlay.classList.remove('show');
  }
}

// =====================================================================
// SICAKLIK GRID — ESP'ye takılı ENDA sayısına göre kart oluşturur/günceller
// 1 ENDA -> tek kart, 2+ ENDA -> 2 sütunlu grid (2x2'ye kadar)
// =====================================================================
class TempGridUI {
  constructor(gridEl, { onSettingsClick, onInfoClick }) {
    this.grid = gridEl;
    this.onSettingsClick = onSettingsClick;
    this.onInfoClick = onInfoClick;
  }

  // Ekranda hiç ENDA kartı yokken gösterilecek durum mesajı
  // (ör. ESP'ye sorulurken, ESP "0 ENDA" yanıtı verince veya yanıt hiç gelmeyince)
  showEmpty(message = 'ENDA modülü bulunamadı', onRetry = null) {
    if (onRetry) {
      this.grid.innerHTML = `
        <div class="placeholder-card fw-error">
          <span>${message}</span>
          <button class="fw-retry-btn" id="tempGridRetryBtn">Tekrar Dene</button>
        </div>`;
      document.getElementById('tempGridRetryBtn').addEventListener('click', onRetry);
    } else {
      this.grid.innerHTML = `<div class="placeholder-card">${message}</div>`;
    }
    this.grid.classList.remove('cols-2');
    delete this.grid.dataset.count;
  }

  update(temps) {
    if (!temps.length) {
      this.showEmpty();
      return;
    }

    const grid = this.grid;
    const count = temps.length;

    if (grid.dataset.count != count) {
      grid.innerHTML = '';
      grid.classList.toggle('cols-2', count > 1);
      temps.forEach((_, i) => {
        const card = document.createElement('div');
        card.className = 'temp-card';
        card.innerHTML = `
          <div class="conn-badge" id="endaLed${i + 1}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5"/>
            </svg>
          </div>

          <div class="temp-header">
            <span class="line left"></span>
            <span class="temp-label">ENDA ${i + 1}</span>
            <span class="line right"></span>
          </div>

          <div class="temp-body">
            <svg class="thermo-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/>
            </svg>
            <span class="temp-value" id="temp${i + 1}Value">--.-</span>
          </div>

          <div class="divider"></div>

          <div class="set-row">
            <span class="set-label">SET:</span>
            <span class="set-value" id="target${i + 1}Value">--.-°C</span>
          </div>

          <div class="temp-card-footer">
            <button class="temp-info-btn" data-enda="${i + 1}" aria-label="Bilgi">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="16" x2="12" y2="12"/>
                <line x1="12" y1="8" x2="12.01" y2="8"/>
              </svg>
            </button>
            <button class="temp-settings-btn" data-enda="${i + 1}" aria-label="Parametreler">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
              </svg>
            </button>
          </div>`;
        grid.appendChild(card);
      });
      grid.dataset.count = count;

      grid.querySelectorAll('.temp-settings-btn').forEach(btn => {
        btn.addEventListener('click', () => this.onSettingsClick(Number(btn.dataset.enda)));
      });
      grid.querySelectorAll('.temp-info-btn').forEach(btn => {
        btn.addEventListener('click', () => this.onInfoClick(Number(btn.dataset.enda)));
      });
    }

    temps.forEach((t, i) => {
      document.getElementById(`temp${i + 1}Value`).textContent = t.current.toFixed(1);
      document.getElementById(`target${i + 1}Value`).textContent = `${t.target.toFixed(1)}°C`;
      document.getElementById(`endaLed${i + 1}`).classList.toggle('on', !!t.connected);
    });
  }
}

// =====================================================================
// BİLGİ POPUP — seçili ENDA'nın detaylarını gösterir
// =====================================================================
class InfoPopup {
  constructor(overlayEl, titleEl, bodyEl, closeBtnEl) {
    this.overlay = overlayEl;
    this.title = titleEl;
    this.body = bodyEl;
    this.currentEnda = null;

    closeBtnEl.addEventListener('click', () => this.close());
    overlayEl.addEventListener('click', (e) => {
      if (e.target === overlayEl) this.close();
    });
  }

  open(endaIndex, temps) {
    this.currentEnda = endaIndex;
    this.title.textContent = `ENDA ${endaIndex} BILGI`;
    this.refresh(temps);
    this.overlay.classList.add('show');
  }

  close() {
    this.currentEnda = null;
    this.overlay.classList.remove('show');
  }

  refresh(temps) {
    if (!this.currentEnda) return;
    const t = temps[this.currentEnda - 1];
    this.body.innerHTML = `
      <div class="info-popup-row"><span class="k">Modbus adres</span><span class="v">0x0${this.currentEnda}</span></div>
      <div class="info-popup-row"><span class="k">Sensör tipi</span><span class="v">PT100</span></div>
      <div class="info-popup-row"><span class="k">Bağlantı</span><span class="v ${t && t.connected ? 'ok' : ''}">${t && t.connected ? 'Aktif' : 'Yok'}</span></div>
      <div class="info-popup-row"><span class="k">Anlık</span><span class="v">${t ? t.current.toFixed(1) + '°C' : '--'}</span></div>
      <div class="info-popup-row"><span class="k">Hedef</span><span class="v">${t ? t.target.toFixed(1) + '°C' : '--'}</span></div>
    `;
  }
}

// =====================================================================
// FAZ ROZETİ — BEKLEMEDE / ÖN ISITMA / PROSES / DURDURULDU
// =====================================================================
class PhaseBadge {
  static LABELS = {
    0: ['BEKLEMEDE', null],
    1: ['ÖN ISITMA', 'preheat'],
    2: ['PROSES', 'process'],
    3: ['DURDURULDU', 'stopped'],
  };

  constructor(badgeEl) {
    this.badge = badgeEl;
  }

  update(fazKodu) {
    this.badge.classList.remove('preheat', 'process', 'stopped');
    const [label, cls] = PhaseBadge.LABELS[fazKodu] || ['BİLİNMİYOR', null];
    this.badge.textContent = label;
    if (cls) this.badge.classList.add(cls);
  }
}

// =====================================================================
// ARIZA KAYITLARI (Sayfa 2) — cihazdan gelen arıza geçmişini gösterir
// Kayıt şekli: { code, type: 'temporary'|'permanent', status: 'active'|'cleared',
//                message, equipment, timestamp, clearedAt }
// =====================================================================
class LogsUI {
  // Sekmeler kayıt alanlarına göre birbirini dışlar:
  // active     -> geçici + hâlâ devam eden (status:active) arızalar
  // permanent  -> tüm kalıcı arızalar (durumdan bağımsız)
  // history    -> geçici + giderilmiş (status:cleared) arızalar, yani geçmiş
  static BUCKETS = {
    active:    r => r.type !== 'permanent' && r.status === 'active',
    permanent: r => r.type === 'permanent',
    history:   r => r.type !== 'permanent' && r.status !== 'active',
  };

  constructor(loadingEl, contentEl, tabPanels) {
    this.loadingEl = loadingEl;
    this.contentEl = contentEl;
    this.tabPanels = tabPanels; // { active: {panel, empty, list}, permanent: {...}, history: {...} }
    this._bindTabs();
  }

  _bindTabs() {
    document.querySelectorAll('.logs-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.logs-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const key = tab.dataset.logsTab;
        Object.entries(this.tabPanels).forEach(([k, { panel }]) => {
          panel.style.display = k === key ? 'flex' : 'none';
        });
      });
    });
  }

  showLoading() {
    this.loadingEl.style.display = 'flex';
    this.contentEl.style.display = 'none';
  }

  render(records) {
    this.loadingEl.style.display = 'none';
    this.contentEl.style.display = 'flex';

    Object.entries(LogsUI.BUCKETS).forEach(([key, matches]) => {
      const { empty, list } = this.tabPanels[key];
      const bucketRecords = records.filter(matches);

      if (!bucketRecords.length) {
        empty.style.display = 'flex';
        list.style.display = 'none';
        return;
      }

      empty.style.display = 'none';
      list.style.display = 'flex';
      list.innerHTML = bucketRecords.map(r => this._renderEntry(r)).join('');
    });
  }

  _renderEntry(r) {
    const typeClass = r.type === 'permanent' ? 'permanent' : 'temporary';
    const typeLabel = r.type === 'permanent' ? 'KALICI' : 'GEÇİCİ';
    const statusClass = r.status === 'active' ? 'active' : 'cleared';
    const statusLabel = r.status === 'active' ? 'AKTİF' : 'GİDERİLDİ';
    const clearedInfo = r.clearedAt ? ` → ${this._formatDate(r.clearedAt)}` : '';

    return `<div class="log-entry">
      <div class="log-entry-header">
        <span class="log-code">${r.code}</span>
        <span class="log-badge ${typeClass}">${typeLabel}</span>
        <span class="log-badge ${statusClass}">${statusLabel}</span>
      </div>
      <div class="log-message">${r.message}</div>
      <div class="log-meta">${r.equipment} · ${this._formatDate(r.timestamp)}${clearedInfo}</div>
    </div>`;
  }

  _formatDate(value) {
    const d = new Date(value);
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
}

// =====================================================================
// YAZILIM GÜNCELLEME (Sayfa 4) — ESP'deki sürüm ile güncel sürümü karşılaştırır
// Cihazdaki sürüm şimdilik BLE'den değil, test hook'undan (testFirmwareVersion)
// geliyor; gerçek BLE OTA protokolü tanımlanınca burası cihazdan okuyacak şekilde
// bağlanacak. Güncelle butonu da şimdilik ilerlemeyi simüle ediyor.
// =====================================================================

// TODO: sürüm bilgisini barındıran gerçek URL'i buraya yazın.
// Beklenen JSON formatı: { "version": "1.3.0", "url": "https://.../firmware.bin", "notes": "..." }
const FIRMWARE_VERSION_URL = 'https://example.com/weldmac/version.json';

class FirmwareUpdateUI {
  // Cihazdan sürüm yanıtı için beklenecek azami süre. Gerçek BLE OTA protokolü
  // tanımlanınca bu, gerçek istek/yanıt zaman aşımı olarak kullanılabilir.
  static DEVICE_VERSION_TIMEOUT_MS = 8000;

  constructor(els) {
    // els: { loadingEl, errorEl, retryBtn, updatingEl, contentEl, currentVersionEl,
    //        latestVersionEl, statusEl, updateBtn, progressFill, progressText }
    this.els = els;
    this.currentVersion = null;
    this.latestVersion = null;
    this._resolveDeviceVersion = null;

    this.els.updateBtn.addEventListener('click', () => this._simulateUpdate());
    this.els.retryBtn.addEventListener('click', () => this._checkVersions());

    this._checkVersions();
  }

  // Gerçek BLE OTA protokolü tanımlanınca cihazdan gelen sürüm yanıtıyla çağrılacak.
  // Test için: testFirmwareVersion('1.2.0')
  setCurrentVersion(version) {
    if (this._resolveDeviceVersion) this._resolveDeviceVersion(version);
  }

  _fetchDeviceVersion() {
    return new Promise((resolve, reject) => {
      this._resolveDeviceVersion = resolve;
      setTimeout(() => reject(new Error('Cihazdan sürüm bilgisi alınamadı (zaman aşımı)')), FirmwareUpdateUI.DEVICE_VERSION_TIMEOUT_MS);
    });
  }

  async _fetchLatestVersion() {
    const res = await fetch(FIRMWARE_VERSION_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    return data.version;
  }

  async _checkVersions() {
    this.els.loadingEl.style.display = 'flex';
    this.els.errorEl.style.display = 'none';
    this.els.contentEl.style.display = 'none';

    const [deviceResult, latestResult] = await Promise.allSettled([
      this._fetchDeviceVersion(),
      this._fetchLatestVersion(),
    ]);

    this.els.loadingEl.style.display = 'none';

    if (deviceResult.status === 'rejected' || latestResult.status === 'rejected') {
      console.error('Sürüm kontrolü başarısız:', deviceResult.reason || latestResult.reason);
      this.els.errorEl.style.display = 'flex';
      return;
    }

    this.currentVersion = deviceResult.value;
    this.latestVersion = latestResult.value;
    this.els.currentVersionEl.textContent = this.currentVersion;
    this.els.latestVersionEl.textContent = this.latestVersion;
    this.els.contentEl.style.display = 'flex';
    this._updateStatus();
  }

  _updateStatus() {
    if (!this.currentVersion || !this.latestVersion) return;
    if (this._compareVersions(this.currentVersion, this.latestVersion) < 0) {
      this.els.statusEl.textContent = 'Güncelleme mevcut';
      this.els.statusEl.className = 'fw-status available';
      this.els.updateBtn.disabled = false;
    } else {
      this.els.statusEl.textContent = 'Cihaz güncel';
      this.els.statusEl.className = 'fw-status uptodate';
      this.els.updateBtn.disabled = true;
    }
  }

  _compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const diff = (pa[i] || 0) - (pb[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }

  _simulateUpdate() {
    this.els.contentEl.style.display = 'none';
    this.els.updatingEl.style.display = 'flex';
    this.els.progressFill.style.width = '0%';
    this.els.progressText.textContent = '0%';

    let pct = 0;
    const timer = setInterval(() => {
      pct += 5;
      this.els.progressFill.style.width = pct + '%';
      this.els.progressText.textContent = pct + '%';
      if (pct >= 100) {
        clearInterval(timer);
        this.els.updatingEl.style.display = 'none';
        this.els.contentEl.style.display = 'flex';
        this.currentVersion = this.latestVersion;
        this.els.currentVersionEl.textContent = this.currentVersion;
        this._updateStatus();
      }
    }, 150);
  }
}

// =====================================================================
// UYGULAMA — tüm bileşenleri oluşturur ve birbirine bağlar
// =====================================================================
class WeldmacApp {
  // Hedef sıcaklığa "ulaşıldı" sayılması için izin verilen fark (°C)
  static TEMP_REACHED_TOLERANCE_C = 2;

  // ENDA sayısı isteği (ISTEK_ENDA_SAYISI) için yeniden deneme ayarları
  static ENDA_COUNT_RETRY_INTERVAL_MS = 1500;
  static ENDA_COUNT_MAX_RETRIES = 5;

  constructor() {
    this.lastTemps = [];
    this._endaCountRetryTimer = null;
    this._endaCountAttempts = 0;

    this.pager = new Pager(document.getElementById('pager'), document.getElementById('dots'));

    this.connUI = new ConnUI(
      document.getElementById('connStatusLed'),
      document.getElementById('connFallbackBtn'),
      document.getElementById('txLed'),
      document.getElementById('rxLed')
    );

    this.phaseBadge = new PhaseBadge(document.getElementById('phaseBadge'));

    this.currentPhase = 0;
    this.preheatBtn = document.getElementById('btnPreheat');
    this.processBtn = document.getElementById('btnProcess');

    this.infoPopup = new InfoPopup(
      document.getElementById('infoOverlay'),
      document.getElementById('infoPopupTitle'),
      document.getElementById('infoPopupBody'),
      document.getElementById('closeInfoPopup')
    );

    this.settingsUI = new SettingsUI();

    this.settingsOverlay = new SettingsOverlay(
      document.getElementById('settingsOverlay'),
      document.getElementById('settingsOverlayTitle'),
      document.getElementById('closeSettingsOverlay')
    );

    this.paramInfoModal = new ParamInfoModal(
      document.getElementById('paramInfoOverlay'),
      document.getElementById('paramInfoTitle'),
      document.getElementById('paramInfoBody'),
      document.getElementById('closeParamInfo')
    );
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.param-info-btn');
      if (!btn) return;
      this.paramInfoModal.open(JSON.parse(decodeURIComponent(btn.dataset.info)));
    });

    this.tempGrid = new TempGridUI(document.getElementById('tempGrid'), {
      onSettingsClick: (endaIndex) => this.settingsOverlay.open(endaIndex),
      onInfoClick: (endaIndex) => this.infoPopup.open(endaIndex, this.lastTemps),
    });

    this.logsUI = new LogsUI(
      document.getElementById('logsLoading'),
      document.getElementById('logsContent'),
      {
        active:    { panel: document.getElementById('logsPanel-active'),    empty: document.getElementById('logsEmpty-active'),    list: document.getElementById('logsList-active') },
        permanent: { panel: document.getElementById('logsPanel-permanent'), empty: document.getElementById('logsEmpty-permanent'), list: document.getElementById('logsList-permanent') },
        history:   { panel: document.getElementById('logsPanel-history'),   empty: document.getElementById('logsEmpty-history'),   list: document.getElementById('logsList-history') },
      }
    );
    this.logsUI.showLoading();

    this.firmwareUpdateUI = new FirmwareUpdateUI({
      loadingEl: document.getElementById('fwLoading'),
      errorEl: document.getElementById('fwError'),
      retryBtn: document.getElementById('fwRetryBtn'),
      updatingEl: document.getElementById('fwUpdating'),
      contentEl: document.getElementById('fwContent'),
      currentVersionEl: document.getElementById('fwCurrentVersion'),
      latestVersionEl: document.getElementById('fwLatestVersion'),
      statusEl: document.getElementById('fwStatus'),
      updateBtn: document.getElementById('fwUpdateBtn'),
      progressFill: document.getElementById('fwProgressFill'),
      progressText: document.getElementById('fwProgressText'),
    });

    this.ble = new BleLink({
      onConnectionChange: (connected) => {
        this.connUI.update(connected);
        if (connected && this.lastTemps.length === 0) {
          this._requestEndaCountWithRetry();
        } else if (!connected) {
          this._stopEndaCountRetry();
        }
      },
      onFrame: (frame) => this._handleFrame(frame),
      onTx: () => this.connUI.flashTx(),
      onRx: () => this.connUI.flashRx(),
    });

    this._bindGlobalUI();
    this._exposeTestHelpers();

    this.ble.tryAutoReconnect();
  }

  _bindGlobalUI() {
    document.getElementById('homeBtn').addEventListener('click', () => {
      this.ble.disconnect();
      window.location.href = '../';
    });

    document.getElementById('connFallbackBtn').addEventListener('click', () => this.ble.requestDevice());

    document.getElementById('btnPreheat').addEventListener('click', () => this.ble.sendEmir(BleLink.CMD_PREHEAT_START));
    document.getElementById('btnProcess').addEventListener('click', () => this.ble.sendEmir(BleLink.CMD_PROCESS_START));
    document.getElementById('btnStop').addEventListener('click', () => this.ble.sendEmir(BleLink.CMD_STOP));
  }

  _handleFrame(frame) {
    if (frame.type === BleLink.TYPE_DURUM) {
      if (frame.id === BleLink.STATUS_SICAKLIK) {
        // payload: [enda_sayısı(1B)] + her ENDA için [current_low, current_high, target_low, target_high, connected(1B)]
        const endaCount = frame.payload[0];
        const temps = [];
        for (let i = 0; i < endaCount; i++) {
          const offset = 1 + i * 5;
          const currentRaw = (frame.payload[offset] | (frame.payload[offset + 1] << 8)) << 16 >> 16;
          const targetRaw  = (frame.payload[offset + 2] | (frame.payload[offset + 3] << 8)) << 16 >> 16;
          const isConnected = frame.payload[offset + 4] === 1;
          temps.push({ current: currentRaw / 10, target: targetRaw / 10, connected: isConnected });
        }
        this.lastTemps = temps;
        this._stopEndaCountRetry(); // gerçek veri geldi, artık sormaya gerek yok
        this.tempGrid.update(temps);
        this.infoPopup.refresh(temps);
        this._updateModeButtons();
      } else if (frame.id === BleLink.STATUS_FAZ_DEGISTI) {
        this.currentPhase = frame.payload[0];
        this.phaseBadge.update(this.currentPhase);
        this._updateModeButtons();
      }
    } else if (frame.type === BleLink.TYPE_YANIT && frame.id === BleLink.YANIT_ENDA_SAYISI) {
      // payload: [enda_sayısı(1B)] — 0 ise gerçek kart verisi (STATUS_SICAKLIK) gelmeyecek demektir
      this._stopEndaCountRetry();
      const endaCount = frame.payload[0];
      if (endaCount === 0) {
        this.tempGrid.showEmpty('ENDA modülü bulunamadı');
      }
    }
  }

  // ENDA sayısını ESP'ye sorar; yanıt gelmezse belirli aralıklarla tekrar dener,
  // azami deneme sayısına ulaşınca "Tekrar Dene" butonlu hata durumunu gösterir.
  _requestEndaCountWithRetry() {
    this._stopEndaCountRetry();
    this._endaCountAttempts = 0;
    this.tempGrid.showEmpty('ENDA sayısı soruluyor...');
    this._sendEndaCountRequest();
  }

  _sendEndaCountRequest() {
    this._endaCountAttempts++;
    this.ble.requestEndaCount();

    if (this._endaCountAttempts >= WeldmacApp.ENDA_COUNT_MAX_RETRIES) {
      this._endaCountRetryTimer = setTimeout(() => {
        this._endaCountRetryTimer = null;
        this.tempGrid.showEmpty('ESP\'den yanıt alınamadı.', () => this._requestEndaCountWithRetry());
      }, WeldmacApp.ENDA_COUNT_RETRY_INTERVAL_MS);
    } else {
      this._endaCountRetryTimer = setTimeout(() => this._sendEndaCountRequest(), WeldmacApp.ENDA_COUNT_RETRY_INTERVAL_MS);
    }
  }

  _stopEndaCountRetry() {
    if (this._endaCountRetryTimer) {
      clearTimeout(this._endaCountRetryTimer);
      this._endaCountRetryTimer = null;
    }
  }

  // Ön Isıtma / Proses butonlarının çerçevesini günceller:
  // mod aktif ve hedef sıcaklığa ulaşılmamışsa "yılan" animasyonu,
  // mod aktif ve hedef sıcaklığa ulaşılmışsa sabit yeşil, aksi halde düz.
  _updateModeButtons() {
    this.preheatBtn.classList.remove('mode-seeking', 'mode-reached');
    this.processBtn.classList.remove('mode-seeking', 'mode-reached');

    if (this.currentPhase !== 1 && this.currentPhase !== 2) return;

    const reached = this.lastTemps.length > 0 &&
      this.lastTemps.every(t => Math.abs(t.current - t.target) <= WeldmacApp.TEMP_REACHED_TOLERANCE_C);

    const activeBtn = this.currentPhase === 1 ? this.preheatBtn : this.processBtn;
    activeBtn.classList.add(reached ? 'mode-reached' : 'mode-seeking');
  }

  // ESP bağlı değilken tarayıcı konsolundan çağırmak için test yardımcıları
  _exposeTestHelpers() {
    window.testTemps = (temps) => {
      this.lastTemps = temps;
      this.tempGrid.update(temps);
      this._updateModeButtons();
    };
    window.testPhase = (fazKodu) => {
      this.currentPhase = fazKodu;
      this.phaseBadge.update(fazKodu);
      this._updateModeButtons();
    };
    // örnek: testLogs([{ code:'E-104', type:'temporary', status:'cleared',
    //   message:'Sıcaklık sensörü kopuk', equipment:'ENDA 1',
    //   timestamp:'2026-07-08T14:32:05', clearedAt:'2026-07-08T14:35:10' }])
    window.testLogs = (records) => this.logsUI.render(records);
    window.testLogsLoading = () => this.logsUI.showLoading();
    // örnek: testFirmwareVersion('1.2.0')
    window.testFirmwareVersion = (version) => this.firmwareUpdateUI.setCurrentVersion(version);
    // ESP'nin ISTEK_ENDA_SAYISI'ya verdiği YANIT_ENDA_SAYISI yanıtını simüle eder
    window.testEndaCount = (count) => this._handleFrame({ type: BleLink.TYPE_YANIT, id: BleLink.YANIT_ENDA_SAYISI, payload: [count] });
    // yanıt hiç gelmeyen senaryoyu (retry + zaman aşımı) test etmek için
    window.testEndaCountTimeout = () => this._requestEndaCountWithRetry();
  }
}

// =====================================================================
// INIT
// =====================================================================
new WeldmacApp();
