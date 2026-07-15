// =====================================================================
// PAGER — yatay kaydırma + alt navigasyon sekmesi senkronizasyonu
// =====================================================================
class Pager {
  // onPageChange(index): kullanıcı gerçekten farklı bir sayfaya geçtiğinde (sekme
  // tıklaması veya kaydırma sonrası) bir kez çağrılır — o sayfaya özel veri
  // isteklerini (ör. arıza kayıtları) tetiklemek için kullanılır.
  constructor(pagerEl, navContainerEl, onPageChange) {
    this.pager = pagerEl;
    this.navTabs = Array.from(navContainerEl.querySelectorAll('.nav-tab'));
    this.onPageChange = onPageChange;
    this._currentIndex = 0;
    this.navTabs.forEach(tab => {
      tab.addEventListener('click', () => this.goToPage(Number(tab.dataset.page)));
    });

    let scrollTimeout;
    this.pager.addEventListener('scroll', () => {
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        const index = Math.round(this.pager.scrollLeft / this.pager.clientWidth);
        this.navTabs.forEach((t, i) => t.classList.toggle('active', i === index));
        this._setCurrentIndex(index);
      }, 60);
    });
  }

  goToPage(index) {
    // clientWidth kullanılıyor çünkü scroll listener'daki aktif-sayfa hesabı da
    // aynı birimi kullanıyor (scrollLeft / clientWidth) — offsetLeft, flex
    // genişliklerindeki yuvarlama farkları yüzünden bundan sapıp snap'in bir
    // komşu sayfaya kaymasına yol açabiliyordu.
    this.pager.scrollTo({ left: index * this.pager.clientWidth, behavior: 'smooth' });
    this._setCurrentIndex(index);
  }

  _setCurrentIndex(index) {
    if (index === this._currentIndex) return;
    this._currentIndex = index;
    if (this.onPageChange) this.onPageChange(index);
  }
}

// =====================================================================
// BAĞLANTI UI — durum LED'i, fallback buton, RX/TX flaş efekti
// =====================================================================
class ConnUI {
  constructor(statusLedEl, txLedEl, rxLedEl) {
    this.statusLed = statusLedEl;
    this.txLed = txLedEl;
    this.rxLed = rxLedEl;
  }

  update(connected) {
    this.statusLed.classList.toggle('on', connected);
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
// BAĞLANTI SAYFASI — BLE bağlı değilken pager'ın yerini alır (bkz. .ble-disconnected,
// style.css). Tarayıcının önceden izin verdiği ("kayıtlı") cihazları
// navigator.bluetooth.getDevices() ile listeler; birine tıklanınca doğrudan o cihaza
// bağlanır (native seçim kutusu açılmaz). Yeni/tanınmayan bir cihaz için "Yeni Cihaz
// Ara" butonu native seçim kutusunu açar.
// =====================================================================
class ConnectionScreen {
  constructor(scanBtnEl, knownBoxEl, knownListEl, { onScan, onConnectKnown }) {
    this.knownBox = knownBoxEl;
    this.knownList = knownListEl;
    this.onConnectKnown = onConnectKnown;
    this._devices = [];

    scanBtnEl.addEventListener('click', () => onScan());
    knownListEl.addEventListener('click', (e) => {
      const item = e.target.closest('.connection-known-item');
      if (!item) return;
      const device = this._devices[Number(item.dataset.deviceIndex)];
      if (device) this.onConnectKnown(device);
    });
  }

  // Bağlantı sayfası gösterileceği her seferinde (_handleDisconnect'te) çağrılır —
  // liste tazelenir çünkü kullanıcı bu arada tarayıcıdan izin sıfırlamış olabilir.
  async refresh() {
    if (!navigator.bluetooth?.getDevices) {
      this.knownBox.style.display = 'none';
      return;
    }
    try {
      this._devices = await navigator.bluetooth.getDevices();
    } catch (err) {
      console.error('Kayıtlı cihazlar alınamadı:', err);
      this._devices = [];
    }

    if (!this._devices.length) {
      this.knownBox.style.display = 'none';
      return;
    }
    this.knownBox.style.display = 'block';
    this.knownList.innerHTML = this._devices.map((d, i) => `
      <div class="connection-known-item" data-device-index="${i}">
        <span class="connection-known-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polygon points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5"/>
          </svg>
        </span>
        <span class="connection-known-name">${d.name || 'Bilinmeyen Cihaz'}</span>
        <svg class="connection-known-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </div>
    `).join('');
  }
}

// =====================================================================
// BLE — OTOMATİK YENİDEN BAĞLANMA + GÖNDER/AL + FRAME OLUŞTURMA/PARSE
// =====================================================================
class BleLink {
  static SERVICE_UUID           = '12345678-1234-1234-1234-123456789abd'; // WELDMAC servis UUID (değiştir)
  static TX_CHARACTERISTIC_UUID = 'abcd1234-ab12-cd34-ef56-abcdef123457'; // Komut gönderme (değiştir)
  static RX_CHARACTERISTIC_UUID = 'abcd1234-ab12-cd34-ef56-abcdef123458'; // Veri alma / notify (değiştir)
  static RECONNECT_RETRY_INTERVAL_MS = 4000; // bağlantı koptuğunda otomatik tekrar deneme aralığı

  // ===== PAKET TİPLERİ =====
  static TYPE_EMIR   = 0x01;
  static TYPE_ISTEK  = 0x02;
  static TYPE_DURUM  = 0x03;
  static TYPE_YANIT  = 0x04;

  // ===== EMIR ID'leri =====
  static CMD_PREHEAT_START = 0x0001;
  static CMD_PROCESS_START = 0x0002;
  static CMD_STOP          = 0x0003;
  static CMD_YAZ_PARAMETRE = 0x0004;
  static CMD_ARIZA_RESET   = 0x0005; // kalıcı bir arızayı manuel resetlemek için
  static CMD_ARIZA_GECMIS_SIL = 0x0006; // "Tüm Geçmişi Sil" butonu — sadece geçmiş (çözülmüş geçici) kayıtlar
  static CMD_SAAT_AYARLA   = 0x0007; // bağlantı kurulunca telefonun sistem saatini gönderir
  static CMD_OTA_BASLAT    = 0x0008; // OTA'ya başlanır, payload: [toplam_boyut(4B LE)]
  static CMD_OTA_PARCA     = 0x0009; // payload: [parca_no(2B LE)][ham firmware byte'ları]
  static CMD_OTA_BITTI     = 0x000A; // payload: [crc32(4B LE)] — tüm parçalar gönderildi

  // ===== DURUM ID'leri =====
  static STATUS_SICAKLIK    = 0x0001;
  static STATUS_FAZ_DEGISTI = 0x0002;
  static STATUS_ADIM_DURUMU = 0x0003; // Proses/profil çalışırken periyodik gönderilir
  static STATUS_GIRISLER    = 0x0004; // Emniyet/faz/pozisyon/sistem girişleri, periyodik
  static STATUS_ARIZA_DEGISTI = 0x0005; // bir arızanın status biti değişince anlık gönderilir (heartbeat'siz, 2x gönderilir)
  static STATUS_CANLI_IZLEME  = 0x0006; // sadece ISTEK_CANLI_IZLEME_BASLA ile DURDUR arasında periyodik gönderilir (I0-I5, I100-I102)

  // ===== İSTEK ID'leri (TYPE_ISTEK ile gönderilir) =====
  static ISTEK_SICAKLIK_SET      = 0x0001;
  static ISTEK_ENDA_BAGLANTI     = 0x0002;
  static ISTEK_TUM_PARAMETRELER  = 0x0003;
  static ISTEK_ADIM_DURUMU       = 0x0004;
  static ISTEK_ARIZA_KAYIT_SAYISI = 0x0005; // önce kaç kayıt var diye sorulur
  static ISTEK_ARIZA_KAYITLARI    = 0x0006; // sayı öğrenilince kayıtların kendisi istenir
  static ISTEK_ARIZA_DETAY        = 0x0007; // bir kayda tıklanınca açıklaması istenir
  static ISTEK_ARIZA_COZUM        = 0x0008; // "Nasıl Çözerim?" basılınca çözüm/kontrol listesi istenir
  static ISTEK_YAZILIM_SURUMU     = 0x0009; // Yazılım Güncelleme sayfası açılınca cihazdaki sürüm istenir
  static ISTEK_CANLI_IZLEME_BASLA  = 0x000A; // "Canlı İzle" paneli açılınca gönderilir — ESP STATUS_CANLI_IZLEME'yi periyodik göndermeye başlar
  static ISTEK_CANLI_IZLEME_DURDUR = 0x000B; // panel kapanınca gönderilir — ESP'nin gereksiz yere yayın yapmasını (BLE/CPU yükünü) önler

  // ===== YANIT ID'leri (TYPE_YANIT ile gelir) =====
  static YANIT_ENDA_BAGLANTI       = 0x0001;
  static YANIT_PARAMETRE           = 0x0002; // her parametre için bir kez gönderilir
  static YANIT_PARAMETRE_BITTI     = 0x0003; // tüm parametreler gönderildi, liste bitti
  static YANIT_PARAMETRE_YAZILDI   = 0x0004; // CMD_YAZ_PARAMETRE onayı
  static YANIT_ARIZA_KAYIT_SAYISI    = 0x0005; // ISTEK_ARIZA_KAYIT_SAYISI cevabı
  static YANIT_ARIZA_KAYDI           = 0x0006; // her arıza kaydı için bir kez gönderilir
  static YANIT_ARIZA_KAYITLARI_BITTI = 0x0007; // tüm kayıtlar gönderildi, liste bitti
  static YANIT_ARIZA_RESET           = 0x0008; // CMD_ARIZA_RESET onayı
  static YANIT_ARIZA_DETAY           = 0x0009; // ISTEK_ARIZA_DETAY cevabı
  static YANIT_ARIZA_COZUM           = 0x000A; // ISTEK_ARIZA_COZUM cevabı
  static YANIT_ARIZA_GECMIS_SIL      = 0x000B; // CMD_ARIZA_GECMIS_SIL onayı
  static YANIT_YAZILIM_SURUMU        = 0x000C; // ISTEK_YAZILIM_SURUMU cevabı
  static YANIT_OTA_HAZIR              = 0x000D; // CMD_OTA_BASLAT cevabı — ESP parça almaya hazır
  static YANIT_OTA_TAMAMLANDI         = 0x000E; // CMD_OTA_BITTI cevabı — ESP doğrulayıp reset atacak
  static YANIT_OTA_PARCA_ALINDI       = 0x000F; // bir GRUP CMD_OTA_PARCA'nın sonunda TEK sefer gelir — parca_no = gruptaki son parçanın no'su

  constructor({ onConnectionChange, onFrame, onTx, onRx }) {
    this.device = null;
    this.txCharacteristic = null;
    this.rxCharacteristic = null;
    this.connected = false;
    this._reconnectTimer = null;
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
      if (this._reconnectTimer) {
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;
      }
      this.onConnectionChange(true);
    } catch (err) {
      console.error('Bağlantı hatası:', err);
      this.connected = false;
      this.onConnectionChange(false);
    }
  }

  // Daha önce izin verilmiş cihaz varsa (kullanıcı seçim penceresi açılmadan) ona
  // bağlanmayı dener. Başarısız olursa (cihaz o an kapalı/menzil dışı olabilir)
  // pes etmeden birkaç saniyede bir tekrar dener — bkz. _scheduleReconnectRetry.
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
        if (!this.connected) this._scheduleReconnectRetry();
      } else {
        this.onConnectionChange(this.connected);
      }
    } catch (err) {
      console.error('Otomatik bağlantı hatası:', err);
      this.onConnectionChange(this.connected);
      this._scheduleReconnectRetry();
    }
  }

  // Kayıtlı bir cihaz varken bağlantı kurulamadıysa birkaç saniye sonra sessizce
  // tekrar dener — kullanıcının her seferinde manuel arama yapmasına gerek kalmaz.
  _scheduleReconnectRetry() {
    if (this._reconnectTimer) return; // zaten bekleyen bir deneme var
    if (!localStorage.getItem('redlift_last_device_id')) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this.connected) this.tryAutoReconnect();
    }, BleLink.RECONNECT_RETRY_INTERVAL_MS);
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
    this._sendQueue = null; // yeni bağlantı temiz bir sırayla başlasın
    this.onConnectionChange(false);
    this._scheduleReconnectRetry(); // cihaz tekrar menzile/açık hâle gelince otomatik bağlan
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

  // Aynı anda iki writeValue() çağrısı olursa Web Bluetooth "GATT operation already
  // in progress" hatası veriyor (ör. bağlanır bağlanmaz sendSaat() ile requestSicaklikSet()
  // art arda, birbirini beklemeden gönderiliyordu). Bunu kökten önlemek için tüm
  // gönderimler tek bir sırada (queue) zincirleniyor — hangi iki komut art arda
  // (OTA parçası dahil) gelirse gelsin birbirini bekler, asla çakışmaz.
  //
  // withoutResponse: true verilirse writeValueWithoutResponse() ile (ESP'nin ATT seviyesinde
  // "aldım" cevabını beklemeden) gönderilir — OTA parçaları (CMD_OTA_PARCA) bunu kullanıyor
  // çünkü ESP'nin kuyruğuna art arda dolduruluyorlar; bütünlük tek tek değil, grubun
  // sonunda YANIT_OTA_PARCA_ALINDI ile doğrulanıyor (bkz. FirmwareUpdateUI._waitBatchAck).
  _send(type, id, payload = [], { withoutResponse = false } = {}) {
    const run = async () => {
      if (!this.connected || !this.txCharacteristic) return;
      try {
        const frame = this._buildFrame(type, id, payload);
        const bytes = new Uint8Array(frame);
        if (withoutResponse && this.txCharacteristic.properties.writeWithoutResponse) {
          await this.txCharacteristic.writeValueWithoutResponse(bytes);
        } else {
          await this.txCharacteristic.writeValue(bytes);
        }
        this.onTx && this.onTx();
      } catch (err) {
        console.error('Gönderme hatası:', err);
      }
    };
    this._sendQueue = (this._sendQueue || Promise.resolve()).then(run, run);
    return this._sendQueue;
  }

  sendEmir(cmdId, payload = []) {
    return this._send(BleLink.TYPE_EMIR, cmdId, payload);
  }

  // Ekranda sıcaklık/set verisi yokken ESP'den anlık veriyi ister.
  requestSicaklikSet() {
    return this._send(BleLink.TYPE_ISTEK, BleLink.ISTEK_SICAKLIK_SET);
  }

  // Bilgi popup'ı açılınca ENDA'nın bağlantı bilgilerini (baud, sensör tipi, modbus adresi) ister.
  requestEndaBaglanti() {
    return this._send(BleLink.TYPE_ISTEK, BleLink.ISTEK_ENDA_BAGLANTI);
  }

  // Ayarlar paneli açılınca tüm Holding/Coil parametre değerlerini ister.
  requestAllParams() {
    return this._send(BleLink.TYPE_ISTEK, BleLink.ISTEK_TUM_PARAMETRELER);
  }

  // Proses ekranı açılınca adım no/toplam adım/kalan süre/hedef sıcaklık bilgisini ister.
  requestAdimDurumu() {
    return this._send(BleLink.TYPE_ISTEK, BleLink.ISTEK_ADIM_DURUMU);
  }

  // Arıza Kayıtları sayfası açılınca önce kaç kayıt olduğunu ister.
  requestArizaKayitSayisi() {
    return this._send(BleLink.TYPE_ISTEK, BleLink.ISTEK_ARIZA_KAYIT_SAYISI);
  }

  // Kayıt sayısı öğrenilince kayıtların kendisini (tek tek akış halinde) ister.
  requestArizaKayitlari() {
    return this._send(BleLink.TYPE_ISTEK, BleLink.ISTEK_ARIZA_KAYITLARI);
  }

  // Bir arıza bloğuna tıklanınca açıklamasını ister (liste çekiminde gelmiyor, anlık istenir).
  requestArizaDetay(code) {
    return this._send(BleLink.TYPE_ISTEK, BleLink.ISTEK_ARIZA_DETAY, this._encodeFixedString(code, 8));
  }

  // "Nasıl Çözerim?" basılınca çözüm/kontrol listesini ister.
  requestArizaCozum(code) {
    return this._send(BleLink.TYPE_ISTEK, BleLink.ISTEK_ARIZA_COZUM, this._encodeFixedString(code, 8));
  }

  // Yazılım Güncelleme sayfası açılınca cihazdaki firmware sürümünü ister.
  requestYazilimSurumu() {
    return this._send(BleLink.TYPE_ISTEK, BleLink.ISTEK_YAZILIM_SURUMU);
  }

  // "Canlı İzle" paneli açılınca/kapanınca çağrılır — ESP'nin STATUS_CANLI_IZLEME
  // yayınını sadece panel açıkken yapmasını sağlar (gereksiz sürekli yayın ESP'ye
  // fazladan yük bindirmesin diye).
  requestCanliIzlemeBasla() {
    return this._send(BleLink.TYPE_ISTEK, BleLink.ISTEK_CANLI_IZLEME_BASLA);
  }

  requestCanliIzlemeDurdur() {
    return this._send(BleLink.TYPE_ISTEK, BleLink.ISTEK_CANLI_IZLEME_DURDUR);
  }

  // OTA'yı başlatır — ESP'ye toplam firmware boyutunu bildirir.
  startOta(totalSize) {
    const bytes = [
      totalSize & 0xFF, (totalSize >> 8) & 0xFF, (totalSize >> 16) & 0xFF, (totalSize >> 24) & 0xFF,
    ];
    return this.sendEmir(BleLink.CMD_OTA_BASLAT, bytes);
  }

  // Tek bir firmware parçasını gönderir (parça no + ham byte'lar). ESP'nin
  // kuyruğuna art arda dolduracağımız için Write Without Response ile gönderilir —
  // grubun tamamı bitince tek bir YANIT_OTA_PARCA_ALINDI ile doğrulanıyor.
  sendOtaChunk(chunkNo, chunkBytes) {
    const header = [chunkNo & 0xFF, (chunkNo >> 8) & 0xFF];
    return this._send(BleLink.TYPE_EMIR, BleLink.CMD_OTA_PARCA, [...header, ...chunkBytes], { withoutResponse: true });
  }

  // Tüm parçalar gönderildi — bütünlük kontrolü için CRC32'yi de yollar.
  finishOta(checksum) {
    const bytes = [
      checksum & 0xFF, (checksum >> 8) & 0xFF, (checksum >> 16) & 0xFF, (checksum >>> 24) & 0xFF,
    ];
    return this.sendEmir(BleLink.CMD_OTA_BITTI, bytes);
  }

  // Kullanıcı bir parametre değerini değiştirince ESP'ye yazma komutu gönderir.
  // rawValue, Modbus register'ın ham (ölçeklenmiş/tam sayı) değeri olmalı.
  writeParam(addr, isCoil, rawValue) {
    const regType = isCoil ? 1 : 0;
    const addrLow = addr & 0xFF;
    const addrHigh = (addr >> 8) & 0xFF;
    const valueLow = rawValue & 0xFF;
    const valueHigh = (rawValue >> 8) & 0xFF;
    return this.sendEmir(BleLink.CMD_YAZ_PARAMETRE, [regType, addrLow, addrHigh, valueLow, valueHigh]);
  }

  // Kalıcı bir arızanın "Resetle" butonuna basılınca gönderilir.
  resetAriza(code) {
    return this.sendEmir(BleLink.CMD_ARIZA_RESET, this._encodeFixedString(code, 8));
  }

  // "Tüm Geçmişi Sil" butonuna basılınca gönderilir — sadece geçmiş (çözülmüş geçici) kayıtları siler.
  clearArizaGecmisi() {
    return this.sendEmir(BleLink.CMD_ARIZA_GECMIS_SIL);
  }

  // BLE bağlantısı kurulunca otomatik gönderilir — ESP'nin RTC'sini telefonun/tarayıcının
  // sistem saatiyle senkronize eder (arıza kayıtlarındaki zaman damgalarının doğru olması için).
  sendSaat() {
    const epochSeconds = Math.floor(Date.now() / 1000);
    const bytes = [
      epochSeconds & 0xFF,
      (epochSeconds >> 8) & 0xFF,
      (epochSeconds >> 16) & 0xFF,
      (epochSeconds >> 24) & 0xFF,
    ];
    return this.sendEmir(BleLink.CMD_SAAT_AYARLA, bytes);
  }

  // Bir metni sabit uzunlukta, boş kısmı 0x00 ile doldurulmuş UTF-8 byte dizisine çevirir
  // (YANIT_ARIZA_KAYDI'nın kod alanını okurken kullanılan _decodeFixedString'in tersi).
  _encodeFixedString(str, length) {
    const bytes = new Array(length).fill(0);
    const encoded = new TextEncoder().encode(str);
    for (let i = 0; i < Math.min(encoded.length, length); i++) bytes[i] = encoded[i];
    return bytes;
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
// `range`: sayısal input'lara yazılan değerin gönderilmeden önce kontrol edildiği
// sınır. `min`/`max` sabitse doğrudan sayı, başka bir register'a bağlıysa (ör. H0
// için H2/H3) `minRef`/`maxRef` o register'ın adresini taşır — canlı sınır,
// SettingsUI önbelleğindeki (ekranda gösterilen, ölçeklenmiş) son bilinen değerden
// okunur (bkz. resolveRangeBounds). Seçim (options) alanlarına range eklenmedi;
// <select> zaten sadece geçerli seçenekleri sunuyor.
const HOLDING_BASE = [
  { addr:0x0000, param:'H0',  tr:'Kontrol çıkışı sıcaklık set değeri',            unit:'°C', def:400, range:{ minRef:0x0002, maxRef:0x0003 },
    info:'Cihazın birincil çalışma sıcaklığı hedefi. Proses ekranındaki "Hedef Sıcaklık" bu değerden okunur/yazılır.',
    notes:['H2 ile H3 arasında olmalıdır.', 'Termostat modunda (C132=0) ve C7=0 iken aktif set değeridir; C7=1 ise H1 kullanılır. Profil modunda (C132=1) ise aktif adımın hedef sıcaklığı geçerlidir, H0 dikkate alınmaz.'] },
  { addr:0x0001, param:'H1',  tr:'Kontrol çıkışı 2. sıcaklık set değeri',         unit:'°C', def:500, range:{ minRef:0x0002, maxRef:0x0003 },
    info:'İkinci bir sıcaklık set noktası — D1/D2 girişi "H0/H1 set seçimi" (H40/H41=1) olarak ayarlanmışsa dış kontaktan hızlıca H0 ile bu değer arasında geçiş yapılabilir.',
    notes:['H2 ile H3 arasında olmalıdır.', 'Sadece C7=1 iken (ya da ilgili dijital giriş ON iken) aktif set değeri olur; profil modunda etkisizdir.'] },
  { addr:0x0002, param:'H2',  tr:'Kontrol çıkışı minimum set değeri limiti',      unit:'°C', def:-30,
    info:'Tüm sıcaklık set değerlerinin (H0, H1, H12, H23, profil adımları, H102) alabileceği en düşük değeri sınırlar.',
    notes:['H3\'ten küçük olmalıdır.', 'Seçilen sensör tipinin (H28) fiziksel ölçüm aralığının altında olmamalıdır.'] },
  { addr:0x0003, param:'H3',  tr:'Kontrol çıkışı maksimum set değeri limiti',     unit:'°C', def:600,
    info:'Tüm sıcaklık set değerlerinin alabileceği en yüksek değeri sınırlar.',
    notes:['H2\'den büyük olmalıdır.', 'Seçilen sensör tipinin (H28) fiziksel ölçüm aralığını aşmamalıdır.'] },
  { addr:0x0004, param:'H4',  tr:'Oransal bant (Pb) — %0.0 ise On-Off kontrol',   unit:'%',  def:4.0, decimals:1, range:{ min:0, max:100 },
    info:'PID kontrolündeki oransal bant genişliği — bant ne kadar dar olursa çıkış set değerine o kadar keskin tepki verir.',
    notes:['%0.0 girilirse kontrol biçimi On-Off\'a döner; bu durumda H5 (histerisiz) belirleyici olur.'] },
  { addr:0x0005, param:'H5',  tr:'Histerisiz değeri',                            unit:'°C', def:2, range:{ min:1, max:50 },
    info:'On-Off kontrol modunda (H4=0) çıkışın açma/kapama arasındaki fark payı — röle/SSR\'nin gereksiz sık anahtarlanmasını (çırpınma) önler.' },
  { addr:0x0006, param:'H6',  tr:'İntegral zamanı',                              unit:'dk', def:4.0, decimals:1, range:{ min:0, max:100 },
    info:'PID\'in integral (I) bileşeni — set değerine yakınken kalan küçük, kalıcı sapmayı zamanla sıfırlar.',
    notes:['0 girilirse integral etkisi devre dışı kalır (sadece P veya PD kontrol).'] },
  { addr:0x0007, param:'H7',  tr:'Türev zamanı',                                 unit:'dk', def:1.00, decimals:2, range:{ min:0, max:25 },
    info:'PID\'in türev (D) bileşeni — ani sıcaklık değişimlerine erken tepki vererek aşmayı (overshoot) azaltır.',
    notes:['0 girilirse türev etkisi devre dışı kalır.'] },
  { addr:0x0008, param:'H8',  tr:'Kontrol periyodu',                             unit:'sn', def:1, range:{ min:1, max:125 },
    info:'Röle/SSR çıkışının PID gücüne göre açık/kapalı oranını uyguladığı döngü süresi.',
    notes:['SSR çıkışlarda kısa (1-2sn) tutulabilir; röle çıkışlarında röle ömrünü korumak için daha uzun tutulması önerilir.'] },
  { addr:0x0009, param:'H9',  tr:'Set değerindeki enerji yüzdesi',               unit:'%',  def:0, range:{ min:0, max:100 },
    info:'Sıcaklık set değerine tam ulaşıldığında çıkışın vereceği taban güç yüzdesi (feed-forward) — sürekli ısı kaybını dengelemek için kullanılır.' },
  { addr:0x000A, param:'H10', tr:'Sensör hatasında kontrol enerji yüzdesi',      unit:'%',  def:0, range:{ min:0, max:100 },
    info:'Sensör arızası (I2≠0) tespit edildiğinde çıkışın sabit olarak vereceği güç yüzdesi — prosesin tamamen durmasını önleyen "güvenli" bir taban güç belirlemede kullanılır.',
    notes:['Sadece C9=0 iken kullanılır; C9=1 ise bunun yerine arıza anındaki son oransal çıkış değeri korunur.'] },
  { addr:0x000B, param:'H11', tr:'Soft-start zamanı',                            unit:'dk', def:0, range:{ min:0, max:250 },
    info:'Cihaza ilk enerji verildiğinde çıkış gücünün 0\'dan hedefe kaç dakikada yükseleceği — ani ısınmayı ve akım sıçramasını yumuşatır.',
    notes:['0 = soft-start kapalı, enerji verilince güç doğrudan hesaplanan PID değerine atlar.'] },
  { addr:0x000C, param:'H12', tr:'Alarm1 sıcaklık set değeri',                   unit:'°C', def:500, range:{ minRef:0x000D, maxRef:0x000E },
    info:'A1 röle çıkışının alarm (H22=0..3) ya da PID soğutma kontrolü (H22=4/5) referans sıcaklığı.',
    notes:['H13 ile H14 arasında olmalıdır.', 'C137=1 ise bu değer yerine H135 ile her profil adımında ayrı A1 kontrolü yapılır.'] },
  { addr:0x000D, param:'H13', tr:'Alarm1 minimum set değeri limiti',             unit:'°C', def:-30,
    info:'H12\'nin alabileceği en düşük değeri sınırlar.', notes:['H14\'ten küçük olmalıdır.'] },
  { addr:0x000E, param:'H14', tr:'Alarm1 maksimum set değeri limiti',            unit:'°C', def:600,
    info:'H12\'nin alabileceği en yüksek değeri sınırlar.', notes:['H13\'ten büyük olmalıdır.'] },
  { addr:0x000F, param:'H15', tr:'Alarm1 oransal bant',                          unit:'%',  def:0.0, decimals:1, range:{ min:0, max:100 },
    info:'A1 çıkışı PID soğutma kontrolü olarak kullanıldığında (H22=4 veya 5) oransal bant değeri.',
    notes:['Sadece H22=4 veya 5 iken anlamlıdır; alarm modlarında (H22=0..3) etkisizdir.'] },
  { addr:0x0010, param:'H16', tr:'Alarm1 histerisiz değeri',                     unit:'°C', def:2, range:{ min:1, max:50 },
    info:'A1 çıkışının açma/kapama sınırındaki histerisiz payı — titremeyi önler.' },
  { addr:0x0011, param:'H17', tr:'Alarm1 integral zamanı',                       unit:'dk', def:0.0, decimals:1, range:{ min:0, max:100 },
    info:'A1 çıkışı PID soğutma kontrolü olarak kullanıldığında (H22=4 veya 5) integral zamanı.',
    notes:['Sadece H22=4 veya 5 iken anlamlıdır.'] },
  { addr:0x0012, param:'H18', tr:'Alarm1 türev zamanı',                         unit:'dk', def:0.00, decimals:2, range:{ min:0, max:25 },
    info:'A1 çıkışı PID soğutma kontrolü olarak kullanıldığında (H22=4 veya 5) türev zamanı.',
    notes:['Sadece H22=4 veya 5 iken anlamlıdır.'] },
  { addr:0x0013, param:'H19', tr:'Alarm1 periyod zamanı',                        unit:'sn', def:1, range:{ min:1, max:250 },
    info:'A1 çıkışının (H22=4/5 soğutma modunda) PID döngü periyodu — H8\'in A1 karşılığı.' },
  { addr:0x0014, param:'H20', tr:'Alarm1 set değerindeki enerji yüzdesi',        unit:'%',  def:0, range:{ min:0, max:100 },
    info:'H22=4/5 iken set değerine ulaşıldığında A1 çıkışının vereceği taban güç yüzdesi — H9\'un A1 karşılığı.' },
  { addr:0x0015, param:'H21', tr:'Sensör hatasında Alarm1 enerji yüzdesi',       unit:'%',  def:0, range:{ min:0, max:100 },
    info:'H22=4/5 iken sensör arızası durumunda A1 çıkışının sabit vereceği güç yüzdesi — H10\'un A1 karşılığı.' },
  { addr:0x0016, param:'H22', tr:'Alarm1 tipi (0:Bağımsız 1:Sapma 2:Band 3:Band-sonrası 4:Bağımsız soğutma 5:Bağıl soğutma)', unit:'', def:0,
    info:'A1 röle çıkışının davranış biçimini seçer: 0-3 alarm modları, 4-5 ise A1\'i PID soğutma çıkışına dönüştürür.',
    notes:['4 veya 5 seçilirse H15/H17/H18/H19/H20/H21 devreye girer; 0-3 seçiliyse bunlar etkisizdir.'] },
  { addr:0x0017, param:'H23', tr:'Alarm2 sıcaklık set değeri',                   unit:'°C', def:500, range:{ minRef:0x0018, maxRef:0x0019 },
    info:'C/A2 röle çıkışının Alarm2 olarak kullanıldığındaki referans sıcaklığı.',
    notes:['H24 ile H25 arasında olmalıdır.', 'C/A2 fiziksel çıkışının Alarm2 işlevi görmesi için H32 kontrol çıkışı olarak SSR/ANL seçilmiş (yani C/A2 boşta) olmalıdır.'] },
  { addr:0x0018, param:'H24', tr:'Alarm2 minimum set değeri limiti',             unit:'°C', def:-30,
    info:'H23\'ün alabileceği en düşük değeri sınırlar.', notes:['H25\'ten küçük olmalıdır.'] },
  { addr:0x0019, param:'H25', tr:'Alarm2 maksimum set değeri limiti',            unit:'°C', def:600,
    info:'H23\'ün alabileceği en yüksek değeri sınırlar.', notes:['H24\'ten büyük olmalıdır.'] },
  { addr:0x001A, param:'H26', tr:'Alarm2 histerisiz değeri',                     unit:'°C', def:2, range:{ min:1, max:50 },
    info:'C/A2 çıkışının açma/kapama sınırındaki histerisiz payı.' },
  { addr:0x001B, param:'H27', tr:'Alarm2 tipi (0:Bağımsız 1:Sapma 2:Band 3:Band-sonrası)', unit:'', def:0,
    info:'C/A2 röle çıkışının Alarm2 olarak davranış biçimini belirler.',
    notes:['C138=1 ise bu değer yerine H136 ile her profil adımında ayrı C/A2 kontrolü yapılır.'] },
  { addr:0x001C, param:'H28', tr:'Giriş (sensör) tipi', unit:'', def:3,
    options:['PT100 ondalıklı','PT100','J ondalıklı','J','K ondalıklı','K','L ondalıklı','L','T ondalıklı','T','S','R','0-20mA','4-20mA','0-10V','2-10V','0-25mV','0-50mV'],
    info:'Bağlı sensörün tipi. Cihazın ölçüm skalasını ve gösterge hassasiyetini belirler — "ondalıklı" seçenekler bir ondalık basamak gösterir.',
    notes:['Değiştirildiğinde H2/H3/H12/H13/H23/H24/H25/profil adımı gibi tüm sıcaklık set/limit değerleri yeni skalaya göre yeniden kontrol edilmelidir.', 'mA/V tiplerinden biri (0-20mA…0-50mV) seçilirse H45/H46/H47 devreye girer, aksi halde bu üç alanın bir karşılığı yoktur (Sensör Girişi sekmesinde otomatik gizlenirler).'] },
  { addr:0x001D, param:'H29', tr:'Isıtma hata kontrol zamanı (0=kapalı)',        unit:'sn', def:60, range:{ min:0, max:1000 },
    info:'Kontrol çıkışı ısıtıyor olmasına rağmen bu süre içinde sıcaklık artmazsa "ısıtma yapılamıyor" hatası (D5) üretilir — rezistans/kontaktör arızasını erken tespit etmek için kullanılır.',
    notes:['0 girilirse bu kontrol tamamen kapalıdır, D5 hatası hiç üretilmez.'] },
  { addr:0x001E, param:'H30', tr:'Modbus haberleşme hızı', unit:'', def:2,
    options:['2400 bps','4800 bps','9600 bps','19200 bps','38400 bps','57200 bps','115200 bps'],
    info:'RS485/Modbus baud hızı — ESP32 ile ENDA arasındaki seri haberleşmenin hızı.',
    notes:['ESP32 tarafındaki UART baud rate ile birebir aynı olmalıdır; uyuşmazsa bağlantı tamamen kesilir.'] },
  { addr:0x001F, param:'H31', tr:'Sayısal filtre katsayısı (1=devre dışı)',      unit:'',   def:20, range:{ min:1, max:200 },
    info:'Ölçülen sıcaklığın gösterge/kontrol öncesi yumuşatılma derecesi. Değer arttıkça gösterge daha kararlı ama tepki daha yavaş olur.',
    notes:['1 = filtre devre dışı, ham (anlık) değer kullanılır.'] },
  { addr:0x0020, param:'H32', tr:'Kontrol çıkışı seçimi', unit:'', def:0,
    options:['C/A2 (Röle)','SSR','SSR/ANL 0-20mA','SSR/ANL 4-20mA'],
    info:'Ana kontrol çıkışının fiziksel biçimini seçer: C/A2 röle, SSR, ya da SSR/ANL üzerinden analog akım çıkışı.',
    notes:['0 dışında bir değer seçilirse C/A2 artık kontrol için kullanılmaz, Alarm2 (H23-H27) olarak serbest kalır.', 'Retransmisyon çıkışının (H42) ayarlanabilmesi için bu değer 0 (C/A2 röle) olmalıdır.'] },
  { addr:0x0021, param:'H33', tr:'Analog çıkış minimum yüzde',                   unit:'%',  def:0, range:{ min:0, max:100 },
    info:'H32 analog seçiliyken (2 veya 3), %0 kontrol gücüne karşılık gelecek fiziksel çıkış yüzdesi.',
    notes:['Sadece H32=2 veya 3 (SSR/ANL analog çıkış) iken anlamlıdır.'] },
  { addr:0x0022, param:'H34', tr:'Analog çıkış maksimum yüzde',                  unit:'%',  def:100, range:{ min:0, max:100 },
    info:'H32 analog seçiliyken, %100 kontrol gücüne karşılık gelecek fiziksel çıkış yüzdesi.',
    notes:['H33\'ten büyük olmalıdır.', 'Sadece H32=2 veya 3 iken anlamlıdır.'] },
  { addr:0x0023, param:'H35', tr:'Offset değeri',                                unit:'',   def:0, range:{ min:-100, max:100 },
    info:'Ölçülen sıcaklığa eklenen sabit düzeltme payı — sensör/kablo kaynaklı sistematik sapmayı (kalibrasyon farkını) telafi etmek için kullanılır.' },
  { addr:0x0027, param:'H39', tr:'Manuel kontrol çıkış yüzdesi',                 unit:'%',  def:50, range:{ min:0, max:100 },
    info:'C8 (Manuel kontrol biti) açıldığında, PID\'i bypass ederek çıkışa doğrudan uygulanacak sabit güç yüzdesi. Ölçüm/test amaçlı elle çıkış vermek için kullanılır.',
    notes:['Sadece C8=1 iken etkilidir; C8=0 ise normal otomatik PID kontrolü geçerlidir.'] },
  { addr:0x0028, param:'H40', tr:'D1 dijital giriş kontrol modu', unit:'', def:0,
    options:['Kullanılmaz','H0/H1 set seçimi','Auto/Manuel','Termostat/Gösterge','Profil start/stop','Hold off/on'],
    info:'D1 kuru kontak girişine bağlı fiziksel butonun/anahtarın hangi işlevi tetikleyeceğini belirler.' },
  { addr:0x0029, param:'H41', tr:'D2 dijital giriş kontrol modu', unit:'', def:0,
    options:['Kullanılmaz','H0/H2 set seçimi','Auto/Manuel','Termostat/Gösterge','Profil start/stop','Hold off/on'],
    info:'D2 kuru kontak girişine bağlı fiziksel butonun/anahtarın hangi işlevi tetikleyeceğini belirler.' },
  { addr:0x002A, param:'H42', tr:'Retransmisyon çıkışı modu (H32=0 olmalı)', unit:'', def:0,
    options:['Kapalı','0-20mA','4-20mA'],
    info:'ANL/SSR çıkışını, kontrol çıkışı olarak değil, ölçülen sıcaklığı analog akıma çevirip dışarı ileten bir "retransmisyon" çıkışına dönüştürür (ör. bir PLC\'ye veya harici göstergeye sıcaklık aktarmak için).',
    notes:['Ayarlanabilmesi için H32=0 (C/A2 röle) olmalıdır — ANL/SSR fiziksel çıkışı aynı anda hem kontrol hem retransmisyon olamaz.'] },
  { addr:0x002B, param:'H43', tr:'Retransmisyon alt skala değeri',               unit:'',   def:-30,
    info:'Retransmisyon aktifken (H42≠0) çıkışın alt ucuna (0mA/4mA) karşılık gelecek sıcaklık değeri.',
    notes:['H44\'ten küçük olmalıdır.', 'Sadece H42≠0 iken anlamlıdır.'] },
  { addr:0x002C, param:'H44', tr:'Retransmisyon üst skala değeri',               unit:'',   def:600,
    info:'Retransmisyon aktifken çıkışın üst ucuna (20mA) karşılık gelecek sıcaklık değeri.',
    notes:['H43\'ten büyük olmalıdır.', 'Sadece H42≠0 iken anlamlıdır.'] },
  { addr:0x002D, param:'H45', tr:'mA/V girişi ondalık nokta ayarı', unit:'', def:0,
    options:['Kapalı','0.0','0.00','0.000'],
    info:'H28 mA/V tiplerinden biriyken ölçüm göstergesinin kaç ondalık basamakla gösterileceğini belirler.',
    notes:['Sadece H28, mA/V giriş tiplerinden biri (0-20mA, 4-20mA, 0-10V, 2-10V, 0-25mV, 0-50mV) iken anlamlıdır.'] },
  { addr:0x002E, param:'H46', tr:'mA/V girişi kullanıcı alt skala',              unit:'',   def:-1999, range:{ min:-10000, max:10000 },
    info:'mA/V giriş tiplerinde, sensörün fiziksel alt sınırının hangi mühendislik değerine karşılık geleceğini belirler (ör. 4-20mA bir basınç sensörünü 0-10 bar olarak ölçeklemek için).',
    notes:['Sadece H28, mA/V giriş tiplerinden biri iken anlamlıdır.', 'H47\'den küçük olmalıdır.'] },
  { addr:0x002F, param:'H47', tr:'mA/V girişi kullanıcı üst skala',              unit:'',   def:2000, range:{ min:-10000, max:10000 },
    info:'mA/V giriş tiplerinde sensörün fiziksel üst sınırının karşılık geleceği mühendislik değeri.',
    notes:['Sadece H28, mA/V giriş tiplerinden biri iken anlamlıdır.', 'H46\'dan büyük olmalıdır.'] },
  { addr:0x0030, param:'H48', tr:'Modbus cihaz adresi',                          unit:'',   def:1, range:{ min:1, max:247 },
    info:'ENDA cihazının RS485/Modbus slave adresi.',
    notes:['ESP32 tarafındaki yapılandırılmış Modbus adresiyle birebir aynı olmalıdır, aksi halde haberleşme tamamen kesilir.'] },
  { addr:0x0034, param:'H52', tr:'RS485 sinyal kaybında çıkış-off zamanı (C11=1 gerekli)', unit:'sn', def:2, range:{ min:2, max:9999 },
    info:'RS485 hattı kesildiğinde bu süre sonunda tüm kontrol çıkışları güvenlik amacıyla otomatik kapatılır.',
    notes:['Çalışması için C11=1 (RS485 kopma hatası kontrolü açık) olmalıdır; C11=0 ise bu süre hiç dikkate alınmaz.'] },
  { addr:0x0064, param:'H100', tr:'Profil zaman bazı', unit:'', def:0, options:['saniye','dakika'],
    info:'16 adımlık profildeki tüm "Adım zaman değeri" alanlarının (H104, H106, …) birimini belirler.' },
  { addr:0x0065, param:'H101', tr:'Maksimum adım sayısı (0=timer/termostat modu)', unit:'', def:8, range:{ min:0, max:16 },
    info:'Profilde kaç adımın kullanılacağını belirler; Proses sekmesindeki adım seçici bu değere göre sınırlanır.',
    notes:['0 seçilirse profil tamamen devre dışı kalır, cihaz her zaman basit timer/termostat modunda çalışır (H135 kullanılır), C132\'nin değeri önemsizleşir.'] },
  { addr:0x0066, param:'H102', tr:'Adım sonu sıcaklık farkı toleransı',          unit:'°C', def:5, range:{ min:0, maxRef:0x0003 },
    info:'Bir adımın süresi dolduğunda, ölçülen sıcaklık hedeften bu değerden fazla uzaktaysa cihaz beklemeye devam eder; fark bu değere düşünce bir sonraki adıma geçilir.',
    notes:['0 ile H3 arasında olmalıdır.', 'Elle düzenlenmesi önerilmez — ESP32 her adım aktifleşince bu register\'ı o adımın kendi tolerans ayarıyla (Proses sekmesindeki adım toleransı) otomatik günceller.'] },
  { addr:0x0087, param:'H135', tr:'Termostat modunda adım zaman değeri',        unit:'sn', def:30, range:{ min:0, max:9999 },
    info:'Profil kullanılmadığında (H101=0 veya C132=0) cihazın basit bir zamanlayıcı gibi çalıştığı süre.',
    notes:['Sadece termostat modunda (C132=0) anlamlıdır; profil modunda (C132=1) adımların kendi süreleri (H104, H106, …) kullanılır.', 'C137=1 ise A1 çıkışının her profil adımındaki durumu için de bu register kullanılır.'] },
];

// ---- HOLDING REGISTERS: 16 adımlık profil (H103..H134 örüntüsü) ----
function getProfileStepRegs(step) { // step: 1..16
  const base = 0x0067 + (step - 1) * 2; // H103 + (step-1)*2
  return {
    target: { addr: base,     param: `H${103 + (step-1)*2}`, tr: `${step}. Adım hedef sıcaklık`, unit:'°C', range:{ minRef:0x0002, maxRef:0x0003 },
      info:`Profildeki ${step}. adımın hedef sıcaklığı — cihaz bu adım aktifken sıcaklığı bu değere getirmeye çalışır.`,
      notes:['H2 ile H3 arasında olmalıdır.'] },
    time:   { addr: base + 1, param: `H${104 + (step-1)*2}`, tr: `${step}. Adım zaman değeri`,    unit:'sn', range:{ min:0, max:9999 },
      info:`Profildeki ${step}. adımın süresi (H100'e göre saniye ya da gün). Hedef sıcaklığa bu süre içinde ulaşılamazsa H102 toleransı devreye girer ve süre uzayabilir.` },
  };
}

// Bir `range` tanımını (bkz. HOLDING_BASE) somut sayılara çözer. Sabit sınır
// (min/max) doğrudan döner; başka bir register'a bağlıysa (minRef/maxRef) o
// register'ın SettingsUI önbelleğindeki — yoksa HOLDING_BASE'deki varsayılan —
// canlı değeri okunur. Böylece ör. H0'ın izin verilen aralığı, kullanıcı H2/H3'ü
// değiştirdikçe otomatik güncellenmiş olur.
function resolveRangeBounds(range, settingsUI) {
  if (!range) return null;
  const resolveBound = (fixedValue, ref, extreme) => {
    if (ref !== undefined) {
      const refParam = HOLDING_BASE.find(p => p.addr === ref);
      const num = Number(settingsUI._cachedValue(ref, false, refParam?.def));
      return Number.isNaN(num) ? extreme : num;
    }
    return fixedValue !== undefined ? fixedValue : extreme;
  };
  return {
    min: resolveBound(range.min, range.minRef, -Infinity),
    max: resolveBound(range.max, range.maxRef, Infinity),
  };
}

// ---- COIL REGISTERS: temel/sistem bitleri ----
const COIL_BASE = [
  { addr:0x0000, param:'C0',  tr:'Alarm2 durumu', options:['Set altında aktif','Set üstünde aktif'],
    info:'C/A2 çıkışı Alarm2 olarak kullanıldığında (H32 ile C/A2 kontrol dışı bırakıldığında) alarmın H23 set değerinin altında mı üstünde mi aktif olacağını belirler.' },
  { addr:0x0001, param:'C1',  tr:'Prob arızasında Alarm2 konumu', options:['Off','On'],
    info:'Sensör arızası (I2≠0) tespit edildiğinde Alarm2 (C/A2) çıkışının güvenlik amacıyla alacağı sabit konum.' },
  { addr:0x0002, param:'C2',  tr:'Alarm1 durumu', options:['Set altında aktif','Set üstünde aktif'],
    info:'A1 çıkışının H12 set değerinin altında mı üstünde mi aktif olacağını belirler.',
    notes:['Sadece H22=0..3 (alarm modları) iken anlamlıdır; H22=4/5 (soğutma kontrolü) iken etkisizdir.'] },
  { addr:0x0003, param:'C3',  tr:'Prob arızasında Alarm1 konumu', options:['Off','On'],
    info:'Sensör arızası tespit edildiğinde A1 çıkışının güvenlik amacıyla alacağı sabit konum.' },
  { addr:0x0004, param:'C4',  tr:'Kontrol çıkışı konfigürasyonu', options:['Isıtma','Soğutma'],
    info:'Ana kontrol çıkışının ısıtma mı soğutma mı yapacağını belirler.',
    notes:['REDLIFT-WELD projesinde tipik kullanım ısıtmadır (0); Soğutma (1) sadece farklı bir proses ihtiyacı varsa değiştirilmelidir.'] },
  { addr:0x0005, param:'C5',  tr:'Sıcaklık birimi', options:['°C','°F'],
    info:'Cihazın iç gösterge/register birimi.',
    notes:['°F\'a çevirmek uygulamadaki tüm sıcaklık gösterimlerini/set değerlerini etkiler — REDLIFT-WELD arayüzü °C varsayımıyla tasarlandı, değiştirilmesi önerilmez.'] },
  { addr:0x0006, param:'C6',  tr:'Kontrol çıkışlarının durumu', options:['Gösterge modu (kapalı)','Aktif'],
    info:'Cihazın gerçek kontrol mü yaptığını yoksa sadece izleme (gösterge) modunda mı olduğunu belirler.',
    notes:['0 (Gösterge modu) yapılırsa tüm kontrol çıkışları kapanır ve proses tamamen durur — sadece ölçüm/test amaçlı kullanılmalıdır.'] },
  { addr:0x0007, param:'C7',  tr:'2. sıcaklık set değerine göre kontrol', options:['H0 kullan','H1 kullan'],
    info:'Aktif sıcaklık set değeri olarak H0 mı H1 mi kullanılacağını seçer.',
    notes:['Sadece termostat modunda (C132=0) geçerlidir; profil modunda (C132=1) aktif adımın hedef sıcaklığı kullanılır ve bu coil etkisizdir.'] },
  { addr:0x0008, param:'C8',  tr:'Manuel kontrol biti', options:['Otomatik','Manuel (H39 yüzdesi)'],
    info:'1 yapıldığında PID/otomatik kontrol devre dışı kalır, çıkış doğrudan H39\'daki sabit güç yüzdesine göre verilir.',
    notes:['Manuel modda alarm ve limit kontrolleri çalışmaya devam eder, sadece çıkış gücü elle belirlenir — normal proses sırasında açık bırakılmamalıdır.'] },
  { addr:0x0009, param:'C9',  tr:'Prob hatasında kontrol biçimi', options:['H10 % oranı','Son oransal değer'],
    info:'Sensör arızasında çıkışın H10\'daki sabit yüzdeye mi, yoksa arıza anındaki son oransal çıkış değerine mi göre devam edeceğini belirler.' },
  { addr:0x000A, param:'C10', tr:'Self tune kontrolü', options:['Durdur','Başlat'],
    info:'PID parametrelerinin (H4, H6, H7, H9) otomatik hesaplanmasını başlatır/durdurur. Sistem ilk kurulumda PID parametreleri bilinmiyorsa kullanılmalıdır (bkz. PID sekmesindeki "Self Tune Başlat" butonu).',
    notes:['Self tune sürerken H4/H6/H7/H9 elle değiştirilmemelidir — hesaplama bitince cihaz bu değerleri kendisi günceller.'] },
  { addr:0x000B, param:'C11', tr:'RS485 bağlantı kopma hatası kontrolü', options:['Kapalı','Açık'],
    info:'Açıldığında, RS485/Modbus hattı H52 saniye boyunca sessiz kalırsa cihaz tüm çıkışları güvenlik amacıyla otomatik kapatır.',
    notes:['Bu kontrolün gerçek anlamda işe yaraması için H52 (kapatma süresi) de mantıklı bir değere ayarlanmalıdır.'] },
  { addr:0x0084, param:'C132', tr:'Kontrol modu seçimi', options:['Termostat modu','Profil kontrol modu'],
    info:'Cihazın basit set-değer/termostat moduyla mı, yoksa 16 adımlık profille mi çalışacağını seçer. REDLIFT-WELD\'in "PROSES" başlatma akışı bu coile bağlıdır.',
    notes:['1 (profil modu) iken H0/H1/C7 etkisizdir, aktif set değeri o an çalışan adımdan gelir.', 'H101=0 ise bu coil\'in değeri önemsizdir, cihaz her zaman termostat modunda davranır.'] },
  { addr:0x0085, param:'C133', tr:'Profil start/stop', options:['Durdur (1. adıma dön)','Start'],
    info:'Profili başlatır (1) ya da durdurup ilk adıma döndürür (0). REDLIFT-WELD\'de "PROSES" butonuna basılınca bu coil 1, "DURDUR" basılınca 0 yapılır.',
    notes:['Sadece C132=1 (profil modu) iken anlamlıdır.'] },
  { addr:0x0086, param:'C134', tr:'Profil hold', options:['Çalışmayı sürdür','Hold (beklet)'],
    info:'Profili bulunduğu adımda/sürede dondurur (1) ya da normal akışına devam ettirir (0) — tam durdurup baştan başlatan C133\'ten farklı olarak aynı noktadan devam edilebilir.' },
  { addr:0x0087, param:'C135', tr:'Profil bitince davranış', options:['Kontrolü bitir','Son set değeriyle devam et'],
    info:'Son adım tamamlandığında kontrol çıkışlarının tamamen kapatılıp kapatılmayacağını (0), yoksa son set değeriyle kontrole devam edilip edilmeyeceğini (1) belirler.' },
  { addr:0x0088, param:'C136', tr:'Enerji kesilmesinde davranış', options:['1. adıma dön','Kaldığı yerden devam et'],
    info:'24V besleme kesilip geri geldiğinde profilin 1. adıma mı döneceğini, yoksa (sıcaklık uygun aralıktaysa) kaldığı yerden mi devam edeceğini belirler.',
    notes:['Beklenmeyen elektrik kesintilerinde prosesin güvenliği/tekrarlanabilirliği açısından önemlidir.'] },
  { addr:0x0089, param:'C137', tr:'A1 çıkış kontrol kaynağı', options:['H22 parametresi','Her adımda (H135)'],
    info:'A1 röle çıkışının normal alarm mantığıyla (H22\'ye göre) mı, yoksa profildeki her adımın kendi A1 coilleriyle (C100-C115) mi kontrol edileceğini seçer.',
    notes:['1 yapılırsa H22\'deki alarm tipi ayarı A1 çıkışı için etkisiz kalır.'] },
  { addr:0x008A, param:'C138', tr:'A2 çıkış kontrol kaynağı', options:['H27 parametresi','Her adımda (H136)'],
    info:'C/A2 çıkışının normal alarm mantığıyla (H27\'ye göre) mı, yoksa profildeki her adımın kendi C/A2 coilleriyle (C116-C131) mi kontrol edileceğini seçer.',
    notes:['1 yapılırsa H27\'deki alarm tipi ayarı C/A2 çıkışı için etkisiz kalır.'] },
];

function getProfileStepCoils(step) { // step: 1..16
  return {
    a1:  { addr: 0x0064 + (step - 1), param: `C${100 + (step-1)}`, tr: `${step}. Adım A1 alarm çıkışı`, options:['Kapalı','Açık'],
      info:`Profildeki ${step}. adım aktifken A1 röle çıkışının açık mı kapalı mı olacağını belirler (ör. bir soğutma vanası ya da ikincil ısıtıcıyı sadece belirli adımlarda tetiklemek için).`,
      notes:['Sadece C137=1 iken etkilidir; C137=0 ise A1 çıkışı H22\'ye göre normal alarm/soğutma mantığıyla kontrol edilir.'] },
    ca2: { addr: 0x0074 + (step - 1), param: `C${116 + (step-1)}`, tr: `${step}. Adım C/A2 alarm çıkışı`, options:['Kapalı','Açık'],
      info:`Profildeki ${step}. adım aktifken C/A2 çıkışının açık mı kapalı mı olacağını belirler.`,
      notes:['Sadece C138=1 iken etkilidir; C138=0 ise C/A2 çıkışı H27\'ye göre normal alarm mantığıyla kontrol edilir.'] },
  };
}

// ---- ADIM BAŞINA SICAKLIK TOLERANSI VE GEÇİŞ KRİTERİ (sanal — ENDA'da yok) ----
// Bunlar gerçek ENDA Modbus register'ları DEĞİL: ESP32 kendi NVS'sinde tutar,
// adım aktifleşince gerekirse ENDA'nın gerçek H102 (0x0066) register'ını buna
// göre günceller. Karışıklık olmasın diye gerçek ENDA haritasından (en fazla
// ~0x8A) açıkça ayrı, 0x0100'den başlayan bir adres bölgesi kullanılıyor.
function getProfileStepTolerance(step) { // step: 1..16 — Holding, sanal
  return {
    addr: 0x0100 + (step - 1), param: `H102STP${step}`, tr: `${step}. Adım sıcaklık toleransı`, unit: '°C', def: 5,
    info:`Profildeki ${step}. adımda hedef sıcaklığa "ulaşılmış" sayılması için izin verilen sapma. Adım aktifleşince ESP32 bu değeri gerçek ENDA H102 register'ına yazar.`,
    notes:['Bu bir ENDA Modbus register\'ı değil, ESP32\'nin kendi hafızasında tuttuğu bir ayardır.'],
  };
}

function getProfileStepCriteria(step) { // step: 1..16 — Coil, sanal
  return {
    addr: 0x0100 + (step - 1), param: `STPKRT${step}`, tr: `${step}. Adım geçiş kriteri`,
    options: ['Adım Başlayınca Değiştir', 'Sıcaklık Değerine Ulaşınca Değiştir'],
    info:`Profildeki ${step}. adımdan bir sonrakine geçiş kriteri: süre dolunca doğrudan geç, ya da hedef sıcaklığa ulaşılınca (adım toleransı içine girince) geç.`,
    notes:['Bu bir ENDA Modbus register\'ı değil, ESP32\'nin kendi hafızasında tuttuğu bir ayardır.'],
  };
}

// "Tüm parametreleri gönder" isteğinden sonra ESP'den kaç adet YANIT_PARAMETRE
// beklediğimiz — Genel/PID/Salt-okunur tablosu + 16 adımın hepsinin register'ları.
// Ayarlar paneli açılınca ilerleme sayacı (X / TOTAL) ve eksik veri kontrolü için kullanılır.
function buildExpectedParamKeys() {
  const keys = new Set();
  HOLDING_BASE.forEach(p => keys.add(`${p.addr}|false`));
  COIL_BASE.forEach(p => keys.add(`${p.addr}|true`));
  for (let step = 1; step <= 16; step++) {
    const regs = getProfileStepRegs(step);
    const coils = getProfileStepCoils(step);
    const tolerance = getProfileStepTolerance(step);
    const criteria = getProfileStepCriteria(step);
    keys.add(`${regs.target.addr}|false`);
    keys.add(`${regs.time.addr}|false`);
    keys.add(`${coils.a1.addr}|true`);
    keys.add(`${coils.ca2.addr}|true`);
    keys.add(`${tolerance.addr}|false`);
    keys.add(`${criteria.addr}|true`);
  }
  return keys;
}
const EXPECTED_PARAM_KEYS = buildExpectedParamKeys();

// ---- INPUT REGISTERS (salt okunur) ----
// Ayarlar panelinde gösterilmiyor — bunlar parametre değil, canlı izleme verisi.
// "Canlı İzle" ekranında (bkz. LiveMonitorUI) kullanılıyor; STATUS_CANLI_IZLEME
// ile periyodik gelen ham değerler burada tanımlı `options`/`info` ile
// biçimlendirilip gösteriliyor.
const INPUT_REGS = [
  { addr:0x0000, param:'I0',   tr:'Ölçülen sıcaklık', unit:'°C',
    info:'Sensörden o an okunan gerçek sıcaklık değeri — Proses ekranındaki büyük sıcaklık göstergesiyle aynı kaynaktan gelir.' },
  { addr:0x0001, param:'I1',   tr:'Analog çıkış yüzdesi', unit:'%',
    info:'Kontrol çıkışının o anki güç oranı (H32 analog seçiliyken gerçek mA/V karşılığı, röle/SSR\'de PID\'in ürettiği güç yüzdesi).' },
  { addr:0x0002, param:'I2',   tr:'Ölçme hata kodu', unit:'',
    options:['Hata yok','Sensör kısa devre','Alt skala hatası','Üst skala hatası','Sensör kopuk','Kalibrasyon hatası'],
    info:'Sensör/ölçüm devresinde o an bir arıza olup olmadığını ve tipini gösterir.',
    notes:['0 dışında bir değer, H10/C9\'daki "sensör hatasında kontrol biçimi" davranışının o an devrede olduğu anlamına gelir.'] },
  { addr:0x0003, param:'I3',   tr:'Self tune durum kodu', unit:'',
    options:['Hata yok','Başlangıç sıcaklığı set değerinin %60\'ından yüksek','PID parametreleri hesaplanıyor','Power set parametresi hesaplanıyor'],
    info:'C10 ile self tune başlatıldığında sürecin hangi aşamada olduğunu gösterir.' },
  { addr:0x0004, param:'I4',   tr:'Aktif sıcaklık set değeri', unit:'°C',
    info:'O an kontrolün hedeflediği gerçek set değeri — termostat modunda H0/H1\'den (C7\'ye göre), profil modunda aktif adımdan gelir.' },
  { addr:0x0005, param:'I5',   tr:'Aktif ondalık nokta değeri', unit:'',
    options:['Ondalık yok','0.0','0.00','0.000'],
    info:'Cihazın gösterge/register değerlerini kaç ondalık basamakla yorumladığını gösterir — H28 sensör tipine göre otomatik belirlenir.' },
  { addr:0x0064, param:'I100', tr:'Aktif adım numarası', unit:'',
    info:'Profil modunda o an çalışmakta olan adımın numarası (1-16).' },
  { addr:0x0065, param:'I101', tr:'Aktif adımın kalan zamanı', unit:'sn',
    info:'Aktif adımın bitmesine kalan süre — Proses ekranındaki "Kalan Süre" göstergesiyle aynı kaynaktan gelir.' },
  { addr:0x0066, param:'I102', tr:'Aktif adımın hedef sıcaklığı', unit:'°C',
    info:'O an çalışan profil adımının hedef sıcaklığı.' },
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

// ---- "Proses" sekmesi: SADECE H0/H1 (aktif set sıcaklıkları) ve profil
// adımlarıyla doğrudan ilgili parametreler. Profil meta (H100/H101, bkz.
// renderProfileMeta) ve adım alanlarının kendisi (bkz. renderStepFields) ayrı
// render fonksiyonlarında zaten gösteriliyor, burada tekrarlanmıyor. Dijital
// Girişler (H40/H41) buradan çıkarıldı — sadece "Tüm Parametreler" sekmesinde.
// C7 (H0/H1 seçim biti) de çıkarıldı — aynı gerekçeyle sadece "Tüm Parametreler"de.
const PROCESS_CATEGORIES = [
  { title: 'Set Sıcaklıkları', holding: [0x0000, 0x0001] },
  // H102 (0x0066) burada YOK: artık adım başına ayrı bir sanal register olarak
  // yönetiliyor (bkz. getProfileStepTolerance) — ESP32 gerçek H102'yi adım
  // değişince otomatik güncellediği için elle düzenlenebilir global alan olarak
  // gösterilmiyor.
];

// "Profil Kontrolü" kartı Proses sekmesinin en altında, adım alanlarının ve
// fabrika sıfırlama butonunun altında ayrı render ediliyor (bkz. renderProcessTab).
const PROFILE_CONTROL_CATEGORY = { title: 'Profil Kontrolü', holding: [0x0087], coil: [0x0084, 0x0085, 0x0086, 0x0087, 0x0088, 0x0089, 0x008A] };

// ---- "Sensör Girişi" sekmesi: giriş tipi ve giriş sinyaliyle ilgili parametreler.
// H2/H3 (kontrol çıkışı min/maks set limiti) buradan çıkarıldı — sadece
// "Tüm Parametreler"de.
const SENSOR_CATEGORIES = [
  { title: 'Sensör Tipi',   holding: [0x001C], coil: [0x0005] },
  { title: 'Giriş Sinyali', holding: [0x001F, 0x0023, 0x002D, 0x002E, 0x002F], coil: [0x0009] },
];

// H28 (Giriş tipi) seçenek indexlerinden hangileri mA/V analog giriş — bu tipler
// seçiliyken H45 (ondalık nokta), H46/H47 (kullanıcı skala) alanları anlamlı olur;
// termokupl/PT100 tiplerinde (ör. J) bu üç alanın bir karşılığı yok, o yüzden
// Sensör Girişi sekmesinde gizleniyorlar (bkz. SettingsUI._updateSensorTypeVisibility).
const ANALOG_INPUT_TYPE_INDICES = [12, 13, 14, 15, 16, 17]; // 0-20mA,4-20mA,0-10V,2-10V,0-25mV,0-50mV
const SENSOR_TYPE_DEPENDENT_ADDRS = [0x002D, 0x002E, 0x002F]; // H45, H46, H47

// ---- "PID" sekmesi: kontrol algoritması parametreleri (Self Tune kartı ayrı,
// sabit HTML'de — bkz. renderPidTab) ----
const PID_CATEGORY = { title: 'PID Ayarları', holding: [0x0004, 0x0005, 0x0006, 0x0007, 0x0008, 0x0009, 0x000A, 0x000B, 0x001D] };

// ---- "Çıkış" sekmesi: fiziksel kontrol çıkışı (röle/SSR/analog) ayarları ----
const OUTPUT_CATEGORY = { title: 'Çıkış Ayarları', holding: [0x0020, 0x0021, 0x0022, 0x0027, 0x002A, 0x002B, 0x002C], coil: [0x0004, 0x0006, 0x0008] };

// ---- "Haberleşme" sekmesi ----
const COMM_CATEGORY = { title: 'Haberleşme', holding: [0x001E, 0x0030, 0x0034], coil: [0x000B] };

// ---- "Alarm" sekmesi: adım bazlı A1/C-A2 alarm coil'leri (C100-C131, bkz.
// getProfileStepCoils) HARİÇ — sadece genel Alarm1/Alarm2 register'ları ----
const ALARM_CATEGORIES = [
  { title: 'Alarm 1', holding: [0x000C, 0x000D, 0x000E, 0x000F, 0x0010, 0x0011, 0x0012, 0x0013, 0x0014, 0x0015, 0x0016], coil: [0x0002, 0x0003] },
  { title: 'Alarm 2', holding: [0x0017, 0x0018, 0x0019, 0x001A, 0x001B], coil: [0x0000, 0x0001] },
];

const SELF_TUNE_COIL_ADDR = 0x000A; // C10

// H100 (zaman birimi) ve H101 (kaç adım kullanılacak) profil adımı seçicisinin
// hemen üstünde, "profil geneli" ayarları olarak gösterilir.
const PROFILE_META_ADDR = { timeBase: 0x0064, stepCount: 0x0065 };

// Bir parametre satırının info (ⓘ) butonunu üretir — SettingsUI (Holding/Coil,
// regType 0/1) ve LiveMonitorUI (Input, regType 3) ortak kullanıyor. Tıklanınca
// WeldmacApp'teki delege edilmiş dinleyici data-info'yu çözüp ParamInfoModal'ı
// doğrudan (ESP'ye sormadan, bkz. ParamInfoModal) açar.
// regType: 0=Holding, 1=Coil, 3=Input.
function renderParamInfoBtn(p, regType) {
  const payload = encodeURIComponent(JSON.stringify({
    param: p.param, addr: p.addr, regType, tr: p.tr, unit: p.unit, def: p.def, options: p.options,
    info: p.info, notes: p.notes,
  }));
  return `<button class="param-info-btn" data-info="${payload}" aria-label="Parametre bilgisi">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" y1="16" x2="12" y2="12"/>
      <line x1="12" y1="8" x2="12.01" y2="8"/>
    </svg>
  </button>`;
}

// =====================================================================
// AYARLAR SAYFASI — parametre/coil satırlarını render eder, sekme ve
// adım seçici davranışını yönetir
// =====================================================================
class SettingsUI {
  constructor() {
    this.tempHasDecimal = true; // H28 sensör tipi öğrenilene kadar varsayılan
    // Profil adımları arası geçişte input'lar yeniden oluşturulduğu için
    // (her adımın register adresi farklı), son bilinen/yazılan değer burada
    // saklanır — yoksa adım değiştirip geri dönünce sabit varsayılana döner.
    this.paramValueCache = new Map();
    this._bindStepSelector();
    this._bindTabs();
    this._bindSelfTune();
    this.renderProcessTab();
    this.renderSensorTab();
    this.renderPidTab();
    this.renderOutputTab();
    this.renderCommTab();
    this.renderAlarmTab();
    this.renderAllParamsTab();
  }

  // extraHtml: satıra ekstra bir rozet eklemek için (ör. adım hedef sıcaklığının
  // sağındaki ±tolerans göstergesi, bkz. renderStepFields).
  renderParamRow(p, isCoil, extraHtml = '') {
    const inputHtml = p.options
      ? `<select class="param-select" data-addr="${p.addr}" data-coil="${!!isCoil}">
          ${p.options.map((opt, i) => `<option value="${i}" ${i === p.def ? 'selected' : ''}>${opt}</option>`).join('')}
        </select>`
      : `<input class="param-input" type="number" data-addr="${p.addr}" data-coil="${!!isCoil}" value="${p.def ?? ''}" />`;

    return `<div class="param-row" data-row-addr="${p.addr}" data-row-coil="${!!isCoil}">
      ${renderParamInfoBtn(p, isCoil ? 1 : 0)}
      <span class="param-label">${p.tr}${p.unit ? ' (' + p.unit + ')' : ''}<span class="param-addr">${p.param} · 0x${p.addr.toString(16).toUpperCase().padStart(4,'0')}</span></span>
      ${inputHtml}
      ${extraHtml}
    </div>`;
  }

  renderCategoryCard(category) {
    const holdingRows = category.holding
      .map(addr => HOLDING_BASE.find(p => p.addr === addr))
      .filter(Boolean)
      .map(p => this.renderParamRow(p, false))
      .join('');
    const coilRows = (category.coil || [])
      .map(addr => COIL_BASE.find(p => p.addr === addr))
      .filter(Boolean)
      .map(p => this.renderParamRow(p, true))
      .join('');
    return `<div class="param-card">
      <div class="section-header">${category.title}</div>
      ${holdingRows}${coilRows}
    </div>`;
  }

  renderProcessTab() {
    document.getElementById('categoryCardsContainer').innerHTML =
      PROCESS_CATEGORIES.map(cat => this.renderCategoryCard(cat)).join('');
    this.renderProfileMeta();
    this.renderStepFields(1);
    document.getElementById('profileControlCardContainer').innerHTML =
      this.renderCategoryCard(PROFILE_CONTROL_CATEGORY);
  }

  renderSensorTab() {
    document.getElementById('sensorCardContainer').innerHTML =
      SENSOR_CATEGORIES.map(cat => this.renderCategoryCard(cat)).join('');
    const sensorTypeParam = HOLDING_BASE.find(p => p.addr === 0x001C);
    this._updateSensorTypeVisibility(Number(this._cachedValue(0x001C, false, sensorTypeParam?.def ?? 0)));
  }

  // H28 (Giriş tipi) değişince, sadece mA/V tiplerinde (bkz. ANALOG_INPUT_TYPE_INDICES)
  // anlamlı olan H45/H46/H47 satırlarını Sensör Girişi sekmesinde gösterir/gizler.
  // "Tüm Parametreler" sekmesine kasıtlı olarak dokunulmuyor — o sekme her zaman
  // ham/eksiksiz register listesini göstermeli.
  _updateSensorTypeVisibility(rawIndex) {
    const isAnalog = ANALOG_INPUT_TYPE_INDICES.includes(rawIndex);
    const container = document.getElementById('sensorCardContainer');
    if (!container) return;
    SENSOR_TYPE_DEPENDENT_ADDRS.forEach(addr => {
      const row = container.querySelector(`.param-row[data-row-addr="${addr}"][data-row-coil="false"]`);
      if (row) row.style.display = isAnalog ? '' : 'none';
    });
  }

  renderAlarmTab() {
    document.getElementById('alarmCardContainer').innerHTML =
      ALARM_CATEGORIES.map(cat => this.renderCategoryCard(cat)).join('');
  }

  // H100 (zaman birimi) + H101 (kaç adım kullanılacak) — adım seçicinin hemen üstünde.
  renderProfileMeta() {
    const timeBaseParam = HOLDING_BASE.find(p => p.addr === PROFILE_META_ADDR.timeBase);
    const stepCountParam = HOLDING_BASE.find(p => p.addr === PROFILE_META_ADDR.stepCount);
    document.getElementById('profileMetaContainer').innerHTML = [
      timeBaseParam && this.renderParamRow(timeBaseParam, false),
      stepCountParam && this.renderParamRow(stepCountParam, false),
    ].filter(Boolean).join('');
  }

  renderPidTab() {
    document.getElementById('pidCardContainer').innerHTML = this.renderCategoryCard(PID_CATEGORY);
    this._updateSelfTuneStatus(0);
  }

  renderOutputTab() {
    document.getElementById('outputCardContainer').innerHTML = this.renderCategoryCard(OUTPUT_CATEGORY);
  }

  renderCommTab() {
    document.getElementById('commCardContainer').innerHTML = this.renderCategoryCard(COMM_CATEGORY);
  }

  // "Tüm Parametreler" sekmesi — kategori kutuları YOK, adres sırasına göre düz liste.
  // İki bölüm var: gerçek ENDA register'ları (Holding, sonra Coil) ve ESP'nin kendi
  // NVS'sinde tuttuğu sanal adım parametreleri (H102STPn tolerans, STPKRTn kriteri).
  // Aynı parametre başka sekmelerde de görünüyor olabilir — sorun değil, applyParamValue
  // zaten querySelectorAll ile TÜM eşleşen alanları güncelliyor.
  renderAllParamsTab() {
    const holdingRows = HOLDING_BASE.map(p => this.renderParamRow(p, false)).join('');
    const stepRegRows = [];
    for (let step = 1; step <= 16; step++) {
      const regs = getProfileStepRegs(step);
      stepRegRows.push(this.renderParamRow({ ...regs.target, def: this._cachedValue(regs.target.addr, false, 200) }, false));
      stepRegRows.push(this.renderParamRow({ ...regs.time, def: this._cachedValue(regs.time.addr, false, 60) }, false));
    }

    const coilRows = COIL_BASE.map(p => this.renderParamRow(p, true)).join('');
    const stepCoilRows = [];
    for (let step = 1; step <= 16; step++) {
      const coils = getProfileStepCoils(step);
      stepCoilRows.push(this.renderParamRow({ ...coils.a1, def: this._cachedValue(coils.a1.addr, true, 0) }, true));
      stepCoilRows.push(this.renderParamRow({ ...coils.ca2, def: this._cachedValue(coils.ca2.addr, true, 0) }, true));
    }

    const virtualRows = [];
    for (let step = 1; step <= 16; step++) {
      const tolerance = getProfileStepTolerance(step);
      const criteria = getProfileStepCriteria(step);
      virtualRows.push(this.renderParamRow({ ...tolerance, def: this._cachedValue(tolerance.addr, false, tolerance.def) }, false));
      virtualRows.push(this.renderParamRow({ ...criteria, def: this._cachedValue(criteria.addr, true, 0) }, true));
    }

    document.getElementById('allParamsContainer').innerHTML = `
      <div class="section-header">ENDA Register'ları — Holding</div>
      ${holdingRows}${stepRegRows.join('')}
      <div class="section-header">ENDA Register'ları — Coil</div>
      ${coilRows}${stepCoilRows.join('')}
      <div class="section-header">ESP Sanal Parametreleri (Adım Bazlı)</div>
      ${virtualRows.join('')}
    `;
  }

  renderStepFields(step) {
    const regs = getProfileStepRegs(step);
    const coils = getProfileStepCoils(step);
    const tolerance = getProfileStepTolerance(step);
    const criteria = getProfileStepCriteria(step);
    const toleranceValue = this._cachedValue(tolerance.addr, false, tolerance.def);
    // Hedef sıcaklığın sağında ±tolerans rozeti — tolerans alanı güncellenince
    // (applyParamValue'da data-tolerance-addr eşleşmesiyle) bu da otomatik tazelenir.
    const toleranceBadge = `<span class="param-tolerance" data-tolerance-addr="${tolerance.addr}">±${toleranceValue}</span>`;
    document.getElementById('stepFieldsContainer').innerHTML = [
      this.renderParamRow({ ...regs.target, def: this._cachedValue(regs.target.addr, false, 200) }, false, toleranceBadge),
      this.renderParamRow({ ...regs.time, def: this._cachedValue(regs.time.addr, false, 60) }, false),
      this.renderParamRow({ ...tolerance, def: toleranceValue }, false),
      this.renderParamRow({ ...criteria, def: this._cachedValue(criteria.addr, true, 0) }, true),
      this.renderParamRow({ ...coils.a1, def: this._cachedValue(coils.a1.addr, true, 0) }, true),
      this.renderParamRow({ ...coils.ca2, def: this._cachedValue(coils.ca2.addr, true, 0) }, true),
    ].join('');
  }

  _bindStepSelector() {
    this.maxStepCount = 16; // H101 (Toplam adım sayısı) öğrenilene kadar tümü gösterilir
    const selector = document.getElementById('stepSelector');
    this._rebuildStepOptions();
    selector.addEventListener('change', () => this.renderStepFields(Number(selector.value)));
  }

  _rebuildStepOptions() {
    const selector = document.getElementById('stepSelector');
    const prevValue = Number(selector.value) || 1;
    selector.innerHTML = '';
    for (let i = 1; i <= this.maxStepCount; i++) {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `Adım ${i}`;
      selector.appendChild(opt);
    }
    selector.value = Math.min(prevValue, this.maxStepCount);
  }

  // H101 (Toplam adım sayısı) değişince adım seçiciyi buna göre sınırlar.
  setMaxStepCount(count) {
    const max = Math.min(Math.max(Math.round(count), 1), 16);
    if (max === this.maxStepCount) return;
    this.maxStepCount = max;
    this._rebuildStepOptions();
    this.renderStepFields(Number(document.getElementById('stepSelector').value));
  }

  _bindTabs() {
    document.querySelectorAll('.settings-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        document.querySelectorAll('.settings-panel').forEach(panel => {
          panel.style.display = panel.id === `panel-${tab.dataset.tab}` ? 'flex' : 'none';
        });
      });
    });
  }

  // "Self Tune Başlat" butonu, C10 select'ini bulup değerini 1 (Başlat) yapar ve
  // bir 'change' olayı fırlatır — böylece yazma işlemi diğer parametrelerle
  // birebir aynı yoldan (WeldmacApp'teki delege edilmiş change dinleyicisi) gider.
  _bindSelfTune() {
    const btn = document.getElementById('selfTuneBtn');
    if (!btn) return;
    btn.addEventListener('click', () => this.writeSelfTuneCoil(1));
  }

  // C10 select'ini bulup verilen değere ayarlar ve 'change' fırlatır — PID
  // sekmesindeki "Self Tune Başlat" butonu VE tam ekran Self Tune ekranının
  // (bkz. SelfTuneScreen) "Self Tune Bitir" butonu bu tek yoldan yazıyor.
  writeSelfTuneCoil(value) {
    const select = document.querySelector(`[data-addr="${SELF_TUNE_COIL_ADDR}"][data-coil="true"]`);
    if (!select) return;
    select.value = String(value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  _updateSelfTuneStatus(value) {
    const statusEl = document.getElementById('selfTuneStatus');
    if (!statusEl) return;
    const param = COIL_BASE.find(p => p.addr === SELF_TUNE_COIL_ADDR);
    statusEl.textContent = `Durum: ${param?.options[value] ?? '--'}`;
    statusEl.classList.toggle('active', value === 1);
  }

  // ESP'den gelen bir parametre değerini, o adrese/coil'e karşılık gelen
  // input/select alan(lar)ına yazar (aynı parametre birden fazla sekmede
  // görünebildiği için querySelectorAll ile hepsi güncellenir).
  // Holding register'lar Modbus'ta hep tam sayı taşındığından, ondalıklı
  // parametreler getDecimalsFor() ile bulunup 10^decimals'a bölünerek
  // gerçek değerine çevrilir.
  applyParamValue(addr, isCoil, value) {
    let displayValue = value;
    if (!isCoil) {
      const decimals = this.getDecimalsFor(addr);
      if (decimals > 0) {
        displayValue = (value / Math.pow(10, decimals)).toFixed(decimals);
      }
    }
    this.paramValueCache.set(this._cacheKey(addr, isCoil), displayValue);
    document.querySelectorAll(`[data-addr="${addr}"][data-coil="${isCoil}"]`).forEach(el => {
      // input/select düzenlenebilir alanlar .value ile güncellenir; Self Tune
      // ekranındaki PID katsayı kutucukları gibi salt-okunur <span> etiketler
      // ise .textContent ile (bkz. index.html .self-tune-pid-value).
      if (el.tagName === 'INPUT' || el.tagName === 'SELECT') {
        el.value = displayValue;
      } else {
        el.textContent = displayValue;
      }
    });
    if (!isCoil) {
      // Bu adres bir adım toleransıysa, hedef sıcaklık satırının sağındaki
      // ±tolerans rozetini de tazele.
      document.querySelectorAll(`[data-tolerance-addr="${addr}"]`).forEach(el => {
        el.textContent = `±${displayValue}`;
      });
    }
    if (isCoil && addr === SELF_TUNE_COIL_ADDR) {
      this._updateSelfTuneStatus(value);
    }
    if (!isCoil && addr === PROFILE_META_ADDR.stepCount) {
      this.setMaxStepCount(value);
    }
    if (!isCoil && addr === 0x001C) {
      this._updateSensorTypeVisibility(value); // H28 — sensör tipi
    }
  }

  _cacheKey(addr, isCoil) {
    return `${addr}|${!!isCoil}`;
  }

  // Önbellekte bir değer varsa onu, yoksa verilen varsayılanı döner —
  // renderStepFields() adım değiştirince sabit placeholder yerine bunu kullanır.
  _cachedValue(addr, isCoil, fallback) {
    const cached = this.paramValueCache.get(this._cacheKey(addr, isCoil));
    return cached !== undefined ? cached : fallback;
  }

  // Bir Holding register'ın kaç ondalık basamakla gösterileceğini belirler:
  // - H4/H6/H7/H15/H17/H18 gibi parametrelerde HOLDING_BASE'deki sabit "decimals"
  // - °C birimli parametrelerde (set/limit/histerisiz/profil hedef sıcaklığı gibi)
  //   H28 sensör tipinin "ondalıklı" olup olmamasına göre (tempHasDecimal)
  // - diğerlerinde 0 (tam sayı)
  getDecimalsFor(addr) {
    const param = HOLDING_BASE.find(p => p.addr === addr);
    if (param?.decimals) return param.decimals;
    if (param?.unit === '°C') return this.tempHasDecimal ? 1 : 0;
    if (this._isProfileStepTargetAddr(addr)) return this.tempHasDecimal ? 1 : 0;
    if (this._isProfileStepToleranceAddr(addr)) return this.tempHasDecimal ? 1 : 0;
    return 0;
  }

  // Profil adımı hedef sıcaklık register'ları H103, H105, H107... (0x0067'den
  // başlayıp 2'şer atlayarak 16 adıma kadar) — aradaki H104, H106... adım
  // süresidir (sn, ondalık gerekmez).
  _isProfileStepTargetAddr(addr) {
    return addr >= 0x0067 && addr <= 0x0067 + 31 && (addr - 0x0067) % 2 === 0;
  }

  // Adım başına sıcaklık toleransı (H102STP1..16, sanal, ESP32 NVS'sinde) — 0x0100'den
  // başlayan 16 adreslik aralık, °C birimli olduğu için sensör tipine göre ondalık.
  _isProfileStepToleranceAddr(addr) {
    return addr >= 0x0100 && addr <= 0x0100 + 15;
  }

  // H28 sensör tipi "ondalıklı" mı değil mi öğrenilince (WeldmacApp'ten) çağrılır.
  setTempDecimalMode(hasDecimal) {
    this.tempHasDecimal = hasDecimal;
  }

  // Bir parametre yazma onayı gelince, o alanın çerçevesini kısaca yeşile
  // yakıp söndürür (bkz. @keyframes paramSavedFlash).
  showWriteConfirmation(addr, isCoil) {
    document.querySelectorAll(`.param-input[data-addr="${addr}"][data-coil="${isCoil}"], .param-select[data-addr="${addr}"][data-coil="${isCoil}"]`).forEach(el => {
      el.classList.remove('saved-flash');
      void el.offsetWidth; // reflow — art arda aynı alana yazılırsa animasyonu yeniden tetikler
      el.classList.add('saved-flash');
    });
  }
}

// =====================================================================
// DAİRESEL İLERLEME HALKASI — Log kayıtları, ENDA parametreleri ve yazılım
// güncelleme (kontrol + gönderim) ekranlarının hepsinde kullanılan tek ortak
// bileşen (bkz. .ring-progress-* stilleri).
// =====================================================================
class RingProgress {
  constructor(ringFillEl, percentEl, countEl) {
    this.ringFillEl = ringFillEl;
    this.percentEl = percentEl;
    this.countEl = countEl;
    const r = ringFillEl.r.baseVal.value;
    this.circumference = 2 * Math.PI * r;
    this.ringFillEl.style.strokeDasharray = `${this.circumference}`;
    this.setPercent(0);
  }

  setPercent(pct) {
    const clamped = Math.min(100, Math.max(0, pct));
    const offset = this.circumference * (1 - clamped / 100);
    this.ringFillEl.style.strokeDashoffset = `${offset}`;
    if (this.percentEl) this.percentEl.textContent = `%${Math.round(clamped)}`;
  }

  // received/total: halkanın içindeki "x / y" sayacını da günceller (Log/Ayarlar'daki kullanım).
  set(received, total) {
    this.setPercent(total > 0 ? (received / total) * 100 : 0);
    if (this.countEl) this.countEl.textContent = `${received} / ${total}`;
  }

  setCount(text) {
    if (this.countEl) this.countEl.textContent = text;
  }
}

// =====================================================================
// ENDA PARAMETRELERİ OVERLAY — tam ekran panel, ENDA modülündeki dişli
// butonuna basılınca açılır
// =====================================================================
class SettingsOverlay {
  constructor(overlayEl, titleEl, closeBtnEl, loadingEl, ringFillEl, percentEl, progressEl, errorEl, errorTextEl, retryBtnEl, bodyEl, onRetry) {
    this.overlay = overlayEl;
    this.title = titleEl;
    this.loadingEl = loadingEl;
    this.ring = new RingProgress(ringFillEl, percentEl, progressEl);
    this.errorEl = errorEl;
    this.errorTextEl = errorTextEl;
    this.bodyEl = bodyEl;
    closeBtnEl.addEventListener('click', () => this.close());
    retryBtnEl.addEventListener('click', () => onRetry());
  }

  // Panel açılır açılmaz "Parametreler Alınıyor" ekranıyla gösterilir;
  // tüm parametreler gelince showContent() ile gerçek içerik açılır.
  open(endaIndex) {
    this.title.textContent = 'EUP1222 PARAMETRELERİ';
    this.loadingEl.style.display = 'flex';
    this.errorEl.style.display = 'none';
    this.bodyEl.style.display = 'none';
    this.overlay.classList.add('show');
  }

  // ESP'den her YANIT_PARAMETRE geldikçe çağrılır — halkayı ve "X / TOTAL" sayacını günceller.
  updateProgress(received, total) {
    this.ring.set(received, total);
  }

  // YANIT_PARAMETRE_BITTI geldiğinde beklenen sayıya ulaşılamamışsa gösterilir.
  showError(missingCount, missingKeys) {
    this.loadingEl.style.display = 'none';
    this.bodyEl.style.display = 'none';
    this.errorEl.style.display = 'flex';
    if (this.errorTextEl) {
      this.errorTextEl.textContent = `${missingCount} parametre alınamadı.`;
    }
    console.warn('Eksik parametreler (addr|isCoil):', missingKeys);
  }

  showContent() {
    this.loadingEl.style.display = 'none';
    this.errorEl.style.display = 'none';
    // .settings-overlay-body bir flex container değil (sekme/paneller normal
    // blok akışıyla alt alta dizilir) — 'flex' vermek satırlara böler.
    this.bodyEl.style.display = 'block';
  }

  close() {
    this.overlay.classList.remove('show');
  }
}

// =====================================================================
// CANLI İZLEME — Input register'larını (I0-I5, I100-I102) gerçek zamanlı gösterir.
// Panel açılınca ISTEK_CANLI_IZLEME_BASLA gönderilir, bundan sonra ESP
// STATUS_CANLI_IZLEME'yi periyodik yayınlar; panel kapanınca DURDUR gönderilip
// yayın kesilir — böylece ESP sadece panel gerçekten açıkken bu veriyi üretir.
// =====================================================================
class LiveMonitorUI {
  constructor(overlayEl, closeBtnEl, bodyEl, { onOpen, onClose }) {
    this.overlay = overlayEl;
    this.body = bodyEl;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.decimals = 1; // H28 sensör tipi öğrenilene kadar varsayılan

    closeBtnEl.addEventListener('click', () => this.close());
    overlayEl.addEventListener('click', (e) => {
      if (e.target === overlayEl) this.close();
    });

    this.body.innerHTML = INPUT_REGS.map(p => `<div class="param-row">
      ${renderParamInfoBtn(p, 3)}
      <span class="param-label">${p.tr}${p.unit ? ' (' + p.unit + ')' : ''}<span class="param-addr">${p.param} · 0x${p.addr.toString(16).toUpperCase().padStart(4,'0')}</span></span>
      <span class="param-value-readonly" data-live-param="${p.param}">--</span>
    </div>`).join('');
  }

  // H28 (Giriş/sensör tipi) değişince WeldmacApp._applySensorType tarafından
  // çağrılır — ProcessScreen.setDecimalMode ile aynı desen.
  setDecimalMode(hasDecimal) {
    this.decimals = hasDecimal ? 1 : 0;
  }

  open() {
    this.overlay.classList.add('show');
    this.onOpen && this.onOpen();
  }

  close() {
    this.overlay.classList.remove('show');
    this.onClose && this.onClose();
  }

  // STATUS_CANLI_IZLEME geldikçe çağrılır — raw: ESP'den gelen ham (ölçeklenmemiş,
  // imzalı) değerler: { i0, i1, i2, i3, i4, i5, i100, i101, i102 }.
  update(raw) {
    this._setValue('I0', this._formatTemp(raw.i0));
    this._setValue('I1', (raw.i1 / 100).toFixed(2));
    this._setValue('I2', this._optionLabel('I2', raw.i2));
    this._setValue('I3', this._optionLabel('I3', raw.i3));
    this._setValue('I4', this._formatTemp(raw.i4));
    this._setValue('I5', this._optionLabel('I5', raw.i5));
    this._setValue('I100', String(raw.i100));
    this._setValue('I101', this._formatDuration(raw.i101));
    this._setValue('I102', this._formatTemp(raw.i102));
  }

  _setValue(param, text) {
    const el = this.body.querySelector(`[data-live-param="${param}"]`);
    if (el) el.textContent = text;
  }

  _formatTemp(raw) {
    return (raw / Math.pow(10, this.decimals)).toFixed(this.decimals);
  }

  _optionLabel(param, value) {
    const p = INPUT_REGS.find(x => x.param === param);
    return p?.options?.[value] ?? `#${value}`;
  }

  _formatDuration(totalSeconds) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
}

// =====================================================================
// SELF TUNE EKRANI — C10 aktifken pager'ın/alt navigasyonun yerini alan tam
// ekran görünüm (bkz. body.self-tune-mode, WeldmacApp._handleSelfTuneCoilChange).
// Anlık sıcaklık + kısa geçmiş grafiği (I0, hedef için I4 referans çizgisi),
// güç çıkışı (I1), aşama durumu (I3) ve PID katsayılarını (H4/H6/H7, bkz.
// applyParamValue'daki genel data-addr güncellemesi) canlı gösterir.
// =====================================================================
class SelfTuneScreen {
  static MAX_HISTORY = 60; // grafikte tutulan son örnek sayısı

  constructor(els, onFinish) {
    this.els = els;
    this._history = [];
    this._targetTemp = null;
    this.decimals = 1; // H28 sensör tipi öğrenilene kadar varsayılan
    this._completed = false; // "Self Tune Tamamlandı" onayı bekleniyor mu
    this._pendingDismiss = null;
    this._finishingTimer = null;
    this._finishingRing = new RingProgress(els.finishingRingFill, els.finishingPercent, els.finishingCount);

    // Normal çalışırken "Bitir" C10'u 0 yazar (onFinish); tamamlanma onayı
    // gösterilirken (bkz. showCompleted) aynı buton sadece ekranı kapatır —
    // C10 zaten cihaz tarafından 0'a döndürülmüş oluyor, tekrar yazmaya gerek yok.
    els.finishBtn.addEventListener('click', () => {
      if (this._completed) {
        const dismiss = this._pendingDismiss;
        this._pendingDismiss = null;
        this._completed = false;
        this._resetFinishBtn();
        if (dismiss) dismiss();
      } else {
        onFinish();
      }
    });
  }

  setDecimalMode(hasDecimal) {
    this.decimals = hasDecimal ? 1 : 0;
  }

  // C10 aktifleşince (bkz. WeldmacApp._handleSelfTuneCoilChange) çağrılır —
  // önceki çalıştırmadan kalan grafik/değerleri temizleyip sıfırdan başlar.
  reset() {
    this._history = [];
    this._targetTemp = null;
    this._completed = false;
    this._pendingDismiss = null;
    this._stopFinishingCountdown();
    this.els.content.style.display = 'flex';
    this.els.finishingLoading.style.display = 'none';
    this.els.tempValue.textContent = '--.-';
    this.els.powerValue.textContent = '--%';
    this.els.powerFill.style.width = '0%';
    this.els.warnInline.style.display = 'none';
    this.els.completeBanner.style.display = 'none';
    this.els.stageRow.style.display = 'flex';
    this._resetFinishBtn();
    this._setStageDom(0);
    this._renderChart();
  }

  // C10 kullanıcı "Bitir"e basmadan kendiliğinden 0'a dönünce çağrılır (bkz.
  // WeldmacApp._handleSelfTuneCoilChange) — aşama/uyarı satırlarını "Tamamlandı"
  // bildirimiyle değiştirir, "Bitir" butonu "Tamam"a dönüşür. Kullanıcı Tamam'a
  // basınca onDismiss çağrılır (ekranı gerçekten kapatan WeldmacApp._exitSelfTuneMode).
  showCompleted(onDismiss) {
    this._completed = true;
    this._pendingDismiss = onDismiss;
    this.els.stageRow.style.display = 'none';
    this.els.warnInline.style.display = 'none';
    this.els.completeBanner.style.display = 'flex';
    this.els.finishBtn.classList.add('completed');
    this.els.finishLabel.textContent = 'Tamam';
  }

  // Kullanıcı "Self Tune Bitir"e basınca çağrılır — C10=0 yazılmış olsa da ESP
  // bunu henüz işlememiş olabilir (bkz. WeldmacApp._handleSelfTuneCoilChange'deki
  // _selfTuneFinishing guard'ı). Normal içeriği (aşama/sıcaklık/güç/PID/buton)
  // gizleyip yerine Ayarlar/Log panellerindeki "Alınıyor" ekranlarıyla AYNI
  // ring-progress bileşenini geri sayım olarak gösterir; süre dolunca onComplete
  // çağrılır (ekranı gerçekten kapatan WeldmacApp._exitSelfTuneMode).
  showFinishing(seconds, onComplete) {
    this._stopFinishingCountdown();
    this.els.content.style.display = 'none';
    this.els.finishingLoading.style.display = 'flex';

    let remaining = seconds;
    this._finishingRing.setPercent(0);
    this._finishingRing.setCount(String(remaining));
    this._finishingTimer = setInterval(() => {
      remaining -= 1;
      this._finishingRing.setPercent(((seconds - remaining) / seconds) * 100);
      this._finishingRing.setCount(String(Math.max(remaining, 0)));
      if (remaining <= 0) {
        this._stopFinishingCountdown();
        onComplete();
      }
    }, 1000);
  }

  _stopFinishingCountdown() {
    if (this._finishingTimer) {
      clearInterval(this._finishingTimer);
      this._finishingTimer = null;
    }
  }

  _resetFinishBtn() {
    this.els.finishBtn.classList.remove('completed');
    this.els.finishLabel.textContent = 'Self Tune Bitir';
  }

  // STATUS_CANLI_IZLEME geldikçe (Self Tune aktifken) çağrılır — raw: ham
  // (ölçeklenmemiş, imzalı) I0/I1/I4 değerleri.
  update({ i0, i1, i4 }) {
    const temp = i0 / Math.pow(10, this.decimals);
    const power = i1 / 100;
    this._targetTemp = i4 / Math.pow(10, this.decimals);

    this.els.tempValue.textContent = temp.toFixed(this.decimals);
    this.els.powerValue.textContent = `${power.toFixed(0)}%`;
    this.els.powerFill.style.width = `${Math.max(0, Math.min(100, power))}%`;

    this._history.push(temp);
    if (this._history.length > SelfTuneScreen.MAX_HISTORY) this._history.shift();
    this._renderChart();
  }

  // I3 (Self tune durum kodu) geldikçe çağrılır: 1 = başlangıç sıcaklığı yüksek
  // (engelleyici uyarı), 2 = PID hesaplanıyor, 3 = güç seviyesi hesaplanıyor.
  setStage(i3Code) {
    this.els.warnInline.style.display = i3Code === 1 ? 'block' : 'none';
    this._setStageDom(i3Code);
  }

  _setStageDom(i3Code) {
    this.els.stageRow.querySelectorAll('.self-tune-stage-step').forEach(el => {
      const stage = Number(el.dataset.stage);
      el.classList.toggle('active', stage === i3Code);
      el.classList.toggle('done', i3Code === 3 && stage === 2);
    });
  }

  _renderChart() {
    const W = 300, H = 90;
    if (this._history.length < 2) {
      this.els.chart.innerHTML = '';
      return;
    }
    let min = Math.min(...this._history);
    let max = Math.max(...this._history);
    if (this._targetTemp !== null) {
      min = Math.min(min, this._targetTemp);
      max = Math.max(max, this._targetTemp);
    }
    if (max - min < 1) { max += 0.5; min -= 0.5; }
    const pad = (max - min) * 0.15;
    min -= pad; max += pad;

    const stepX = W / (this._history.length - 1);
    const yFor = (t) => H - ((t - min) / (max - min)) * H;
    const points = this._history.map((t, i) => `${(i * stepX).toFixed(1)},${yFor(t).toFixed(1)}`).join(' ');

    const refLine = this._targetTemp !== null
      ? `<line x1="0" y1="${yFor(this._targetTemp).toFixed(1)}" x2="${W}" y2="${yFor(this._targetTemp).toFixed(1)}" stroke="#475569" stroke-width="1.5" stroke-dasharray="5 4"/>`
      : '';

    this.els.chart.innerHTML = `
      ${refLine}
      <polyline points="${points}" fill="none" stroke="#22d3ee" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    `;
  }
}

// =====================================================================
// PARAMETRE BİLGİ MESAJI — parametre satırındaki info ikonuna basılınca açılır.
// Açıklama ve uyarı notları artık ESP'den istenmiyor (eskiden ISTEK_PARAMETRE_DETAY
// ile her tıklamada ESP'ye ayrı bir istek gidiyordu — cihaz üzerinde ~70 register
// için metin tutmak/parçalayıp göndermek gereksiz yük oluşturuyordu). Bunun yerine
// her parametrenin `info` (ne işe yarar) ve `notes` (koşullu uyarılar, ör. "H2 ile
// H3 arasında olmalıdır") alanları doğrudan HOLDING_BASE/COIL_BASE'de (bkz.
// app.js üstü) tanımlı — bu yüzden popup tamamen anlık ve yerel açılıyor.
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

    const descHtml = data.info ? `<div class="param-info-desc">${data.info}</div>` : '';
    const warnHtml = data.notes?.length
      ? `<div class="param-info-warnings">${data.notes.map(w => `<div class="param-info-warn">⚠ ${w}</div>`).join('')}</div>`
      : '';

    this.body.innerHTML = `
      ${descHtml}${warnHtml}
      ${rows.map(([k, v]) => `<div class="info-popup-row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('')}
    `;
    this.overlay.classList.add('show');
  }

  close() {
    this.overlay.classList.remove('show');
  }
}

// =====================================================================
// ARIZA DETAY MESAJI — bir arıza bloğuna tıklanınca açılır. Açıklama ve çözüm
// metni burada TUTULMAZ, ikisi de ESP'den anlık istenir (hızlı liste çekimi
// için): açılınca ISTEK_ARIZA_DETAY, "Nasıl Çözerim?" basılınca ISTEK_ARIZA_COZUM.
// =====================================================================
class LogInfoModal {
  constructor(overlayEl, titleEl, bodyEl, closeBtnEl) {
    this.overlay = overlayEl;
    this.title = titleEl;
    this.body = bodyEl;
    this.currentCode = null;

    closeBtnEl.addEventListener('click', () => this.close());
    overlayEl.addEventListener('click', (e) => {
      if (e.target === overlayEl) this.close();
    });
  }

  // Bloğa tıklanınca çağrılır — WeldmacApp aynı anda ISTEK_ARIZA_DETAY gönderir.
  // occurrences zaten listede elimizde olduğu için (oluşma/giderilme zamanları) ESP'yi
  // beklemeden hemen gösterilir; sadece açıklama/çözüm anlık isteniyor.
  open(code, occurrences) {
    this.currentCode = code;
    this.title.textContent = code;
    const timesHtml = (occurrences || []).map(renderLogTimeRow).join('');

    this.body.innerHTML = `
      <div class="log-times log-info-times">${timesHtml}</div>
      <div id="logInfoDetailSection"><div class="log-detail-loading">Detay alınıyor…</div></div>
    `;
    this.overlay.classList.add('show');
  }

  // YANIT_ARIZA_DETAY gelince çağrılır.
  showDetail(code, description) {
    if (code !== this.currentCode) return; // kullanıcı bu arada başka bir kayda geçmiş olabilir
    const section = this.body.querySelector('#logInfoDetailSection');
    if (!section) return;
    section.innerHTML = `
      <div class="param-info-desc">${description}</div>
      <button class="log-solution-btn" data-log-solution="${code}">Nasıl Çözerim?</button>
    `;
  }

  // "Nasıl Çözerim?" tıklanınca çağrılır — WeldmacApp aynı anda ISTEK_ARIZA_COZUM gönderir.
  showSolutionLoading(code) {
    if (code !== this.currentCode) return;
    const btn = this.body.querySelector('.log-solution-btn');
    if (btn) { btn.textContent = 'Çözüm alınıyor…'; btn.disabled = true; }
  }

  // YANIT_ARIZA_COZUM gelince çağrılır — çözüm metni "\n" ile ayrılmış satırlardan oluşur.
  showSolution(code, solutionText) {
    if (code !== this.currentCode) return;
    const items = solutionText.split('\n').map(s => s.trim()).filter(Boolean);
    const checksHtml = items.length
      ? `<ul class="log-info-checklist">${items.map(c => `<li>${c}</li>`).join('')}</ul>`
      : `<div class="param-info-desc">Çözüm bilgisi bulunamadı.</div>`;
    const btn = this.body.querySelector('.log-solution-btn');
    if (btn) btn.remove();
    const section = this.body.querySelector('#logInfoDetailSection');
    if (section) section.insertAdjacentHTML('beforeend', checksHtml);
  }

  close() {
    this.overlay.classList.remove('show');
  }
}

// =====================================================================
// ARIZA RESETLEME ONAYI — "Resetle" butonuna basılınca, ekipmanın gerçekten
// kontrol edildiğini onaylatmadan CMD_ARIZA_RESET gönderilmez.
// =====================================================================
class ResetConfirmModal {
  constructor(overlayEl, closeBtnEl, cancelBtnEl, okBtnEl, onConfirm) {
    this.overlay = overlayEl;
    this.code = null;
    this.onConfirm = onConfirm;

    closeBtnEl.addEventListener('click', () => this.close());
    cancelBtnEl.addEventListener('click', () => this.close());
    overlayEl.addEventListener('click', (e) => {
      if (e.target === overlayEl) this.close();
    });
    okBtnEl.addEventListener('click', () => {
      const code = this.code;
      this.close();
      if (code) this.onConfirm(code);
    });
  }

  open(code) {
    this.code = code;
    this.overlay.classList.add('show');
  }

  close() {
    this.overlay.classList.remove('show');
    this.code = null;
  }
}

// Yazılım güncelleme öncesi "bağlantı kopmasın" uyarısıyla onay alan basit modal —
// ResetConfirmModal ile aynı mantık, sadece parametre (code) taşımıyor.
class FwUpdateConfirmModal {
  constructor(overlayEl, closeBtnEl, cancelBtnEl, okBtnEl, onConfirm) {
    this.overlay = overlayEl;
    this.onConfirm = onConfirm;

    closeBtnEl.addEventListener('click', () => this.close());
    cancelBtnEl.addEventListener('click', () => this.close());
    overlayEl.addEventListener('click', (e) => {
      if (e.target === overlayEl) this.close();
    });
    okBtnEl.addEventListener('click', () => {
      this.close();
      this.onConfirm();
    });
  }

  open() {
    this.overlay.classList.add('show');
  }

  close() {
    this.overlay.classList.remove('show');
  }
}

// H36 (0x0024, "Fonksiyon kontrol parametresi") kasıtlı olarak HOLDING_BASE'e
// eklenmedi — PDF bu register için "EndaLink uygulamasından değiştirilmemelidir!!"
// uyarısı veriyor. Self-tune zaten C10 coil'i üzerinden yapılıyor; H36'nın tek
// gerçek kullanım alanı bu iki fabrika-sıfırlama magic değeri, o yüzden serbest
// düzenlenebilir bir alan yerine korumalı, onaylı bir buton çifti olarak sunuluyor.
const FACTORY_RESET_CODES = { general: 23042, profile: 23043 }; // 5A02h / 5A03h
const FACTORY_RESET_DESCRIPTIONS = {
  general: 'Set sıcaklıkları, PID, alarm, sensör ve haberleşme ayarları (H0-H51, C0-C10) fabrika değerlerine dönecek. Bu işlem geri alınamaz.',
  profile: 'Tüm profil adımları (H100-H137, C100-C138) fabrika değerlerine dönecek. Bu işlem geri alınamaz.',
};

class FactoryResetConfirmModal {
  constructor(overlayEl, descEl, closeBtnEl, cancelBtnEl, okBtnEl, onConfirm) {
    this.overlay = overlayEl;
    this.desc = descEl;
    this.kind = null;
    this.onConfirm = onConfirm;

    closeBtnEl.addEventListener('click', () => this.close());
    cancelBtnEl.addEventListener('click', () => this.close());
    overlayEl.addEventListener('click', (e) => {
      if (e.target === overlayEl) this.close();
    });
    okBtnEl.addEventListener('click', () => {
      const kind = this.kind;
      this.close();
      if (kind) this.onConfirm(kind);
    });
  }

  open(kind) {
    this.kind = kind;
    this.desc.textContent = FACTORY_RESET_DESCRIPTIONS[kind] ?? '';
    this.overlay.classList.add('show');
  }

  close() {
    this.overlay.classList.remove('show');
    this.kind = null;
  }
}

// Genel amaçlı tek-butonlu uyarı kutusu — şu an sadece parametre aralık
// doğrulaması (bkz. WeldmacApp._validateParamRange) tarafından kullanılıyor.
class AlertModal {
  constructor(overlayEl, titleEl, messageEl, closeBtnEl, okBtnEl) {
    this.overlay = overlayEl;
    this.title = titleEl;
    this.message = messageEl;

    closeBtnEl.addEventListener('click', () => this.close());
    okBtnEl.addEventListener('click', () => this.close());
    overlayEl.addEventListener('click', (e) => {
      if (e.target === overlayEl) this.close();
    });
  }

  open(title, message) {
    this.title.textContent = title;
    this.message.textContent = message;
    this.overlay.classList.add('show');
  }

  close() {
    this.overlay.classList.remove('show');
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
    this.connInfo = null; // { modbusAddr, sensorType, baudRate } — ESP'den yanıt gelince dolar

    closeBtnEl.addEventListener('click', () => this.close());
    overlayEl.addEventListener('click', (e) => {
      if (e.target === overlayEl) this.close();
    });
  }

  open(endaIndex, temps) {
    this.currentEnda = endaIndex;
    this.connInfo = null; // her açılışta bağlantı bilgisi yeniden istenecek
    this.title.textContent = 'EUP1222 BİLGİ';
    this.refresh(temps);
    this.overlay.classList.add('show');
  }

  close() {
    this.currentEnda = null;
    this.overlay.classList.remove('show');
  }

  // ESP'den ISTEK_ENDA_BAGLANTI yanıtı (YANIT_ENDA_BAGLANTI) gelince çağrılır.
  setConnectionInfo(connInfo) {
    this.connInfo = connInfo;
    if (!this.currentEnda) return; // popup kapandıysa gösterecek bir şey yok
    const modbusEl = document.getElementById('infoModbusAddr');
    const sensorEl = document.getElementById('infoSensorType');
    const baudEl = document.getElementById('infoBaudRate');
    if (modbusEl) modbusEl.textContent = connInfo.modbusAddr;
    if (sensorEl) sensorEl.textContent = connInfo.sensorType;
    if (baudEl) baudEl.textContent = connInfo.baudRate;
  }

  refresh(temps) {
    if (!this.currentEnda) return;
    const t = temps[this.currentEnda - 1];
    const c = this.connInfo;
    this.body.innerHTML = `
      <div class="info-popup-row"><span class="k">Modbus Adresi</span><span class="v" id="infoModbusAddr">${c ? c.modbusAddr : '...'}</span></div>
      <div class="info-popup-row"><span class="k">Sensör Tipi</span><span class="v" id="infoSensorType">${c ? c.sensorType : '...'}</span></div>
      <div class="info-popup-row"><span class="k">Baud Rate</span><span class="v" id="infoBaudRate">${c ? c.baudRate : '...'}</span></div>
      <div class="info-popup-row"><span class="k">Bağlantı</span><span class="v ${t && t.connected ? 'ok' : ''}">${t && t.connected ? 'Aktif' : 'Yok'}</span></div>
    `;
  }
}

// =====================================================================
// PROSES/DURUM EKRANI — anasayfanın kalıcı parçası: BEKLEMEDE/ÖN ISITMA'da
// yer tutucu (pasif) gösterir, PROSES'te aktif adım/hedef sıcaklık/kalan süreyi
// gösterir. Artık ayrı bir ekran değil — tek anasayfanın faza göre değişen kısmı.
// =====================================================================
class ProcessScreen {
  static PHASE_LABELS = { 0: 'BEKLEME MODU', 1: 'ÖN ISITMA' };

  // ESP'den gelen kalan süre BLE gecikmesi/jitter yüzünden düzensiz aralıklarla
  // geliyor — her paketi doğrudan ekrana yazmak geri sayımı "titretiyor".
  // Bunun yerine: adım başına süreyi bir kez alıp kendi setInterval'ımızla
  // saniyede bir geri sayıyoruz. ESP'den gelen değerle aramızdaki fark bu
  // aralıktan büyük ve bu süreden uzun zamandır kontrol edilmediyse düzeltiyoruz.
  static DRIFT_CHECK_INTERVAL_MS = 5000;
  static DRIFT_TOLERANCE_SECONDS = 4;

  constructor(els) {
    this.els = els; // { stepLabel, targetRow, targetTemp, targetTolerance, remainingWrap, remaining }
    this.decimals = 1;
    this._stepNo = null;
    this._localRemaining = null;
    this._countdownTimer = null;
    this._lastDriftCheckAt = 0;
  }

  setDecimalMode(hasDecimal) {
    this.decimals = hasDecimal ? 1 : 0;
  }

  // ENDA'dan her STATUS_SICAKLIK_SET geldiğinde çağrılır — faz ne olursa olsun
  // anlık sıcaklık her zaman canlı gösterilir (bekleme/ön ısıtmada da).
  updateCurrentTemp(current) {
    this.els.currentTemp.textContent = current.toFixed(this.decimals);
  }

  // BLE bağlantısı kesilince çağrılır — gerçek "0" değil, "--.-" yer tutucusuna döner.
  resetCurrentTemp() {
    this.els.currentTemp.textContent = '--.-';
  }

  // BEKLEMEDE (0) ya da ÖN ISITMA (1) fazına geçilince (ya da bağlantı kesilince) çağrılır.
  // currentTarget: ENDA'nın o anki SET (hedef) değeri (STATUS_SICAKLIK_SET'ten) — adım
  // kavramı olmadığı için tolerans yok (±--), Kalan Süre ise anlamsız olduğu için gizlenir.
  showIdleOrPreheat(phase, currentTarget) {
    this._stopCountdown();
    this._stepNo = null;
    this._localRemaining = null;
    this.els.stepLabel.textContent = ProcessScreen.PHASE_LABELS[phase] || 'BEKLEME MODU';
    this.updateIdleTarget(currentTarget);
    this.els.remaining.textContent = '--:--';
    this.els.remainingWrap.style.display = 'none';
  }

  // BEKLEMEDE/ÖN ISITMA fazındayken ESP'den her STATUS_SICAKLIK_SET geldiğinde çağrılır —
  // hedef sıcaklık alanı her zaman ENDA'nın o anki gerçek SET değerini gösterir.
  updateIdleTarget(currentTarget) {
    if (currentTarget != null) {
      this.els.targetRow.classList.remove('passive');
      this.els.targetTemp.textContent = `${currentTarget.toFixed(this.decimals)}°C`;
    } else {
      this.els.targetRow.classList.add('passive');
      this.els.targetTemp.textContent = '--.-°C';
    }
    if (this.els.targetTolerance) this.els.targetTolerance.textContent = '±--';
  }

  // configuredDuration: Ayarlar'dan bilinen (kullanıcının o adım için girdiği) tam
  // süre — varsa yeni adıma geçişte ESP'nin o anki kalan_süre'sini beklemeden/ona
  // güvenmeden sayaç HEMEN bu değerle başlar (ESP'nin ilk paketi gecikebiliyor ya da
  // tam geçiş anında henüz kendi sayacını sıfırlamamış olabiliyor). Ardından normal
  // periyodik drift kontrolü ESP'nin gerçek değeriyle karşılaştırıp düzeltmeye devam eder.
  updateStep({ stepNo, totalSteps, remainingSeconds, targetTemp, tolerance, configuredDuration }) {
    this.els.targetRow.classList.remove('passive');
    this.els.remainingWrap.style.display = '';
    this.els.stepLabel.textContent = `ADIM ${stepNo} / ${totalSteps}`;
    this.els.targetTemp.textContent = `${targetTemp.toFixed(this.decimals)}°C`;
    if (this.els.targetTolerance && tolerance !== undefined) {
      this.els.targetTolerance.textContent = `±${tolerance.toFixed(this.decimals)}`;
    }

    const now = Date.now();
    if (stepNo !== this._stepNo) {
      // Yeni adım: Ayarlar'dan bilinen tam süre varsa ondan başla (anında, güvenilir);
      // bilinmiyorsa (Settings hiç açılmadıysa) ESP'nin bu paketteki değerine düş.
      this._stepNo = stepNo;
      this._localRemaining = (configuredDuration != null && configuredDuration > 0)
        ? configuredDuration
        : remainingSeconds;
      this._lastDriftCheckAt = now;
      this._startCountdown();
    } else if (now - this._lastDriftCheckAt >= ProcessScreen.DRIFT_CHECK_INTERVAL_MS) {
      // Aynı adım, DRIFT_CHECK_INTERVAL_MS'den fazla zaman geçmiş: ESP'nin değeriyle karşılaştır.
      const diff = Math.abs(this._localRemaining - remainingSeconds);
      if (diff > ProcessScreen.DRIFT_TOLERANCE_SECONDS) {
        this._localRemaining = remainingSeconds;
      }
      this._lastDriftCheckAt = now;
    }

    this._renderRemaining();
  }

  _startCountdown() {
    this._stopCountdown();
    this._countdownTimer = setInterval(() => {
      if (this._localRemaining > 0) this._localRemaining--;
      this._renderRemaining();
    }, 1000);
  }

  _stopCountdown() {
    if (this._countdownTimer) {
      clearInterval(this._countdownTimer);
      this._countdownTimer = null;
    }
  }

  _renderRemaining() {
    this.els.remaining.textContent = this._formatTime(this._localRemaining);
  }

  _formatTime(totalSeconds) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
}

// =====================================================================
// EMNİYET & SİSTEM GİRİŞLERİ (Sayfa 3) — ESP'nin GPIO girişlerinin canlı
// durumunu gösterir. Buton engelleme yok; ESP zaten emniyetsiz durumda
// komutu reddediyor, biz sadece izliyoruz.
// =====================================================================
class SafetyIoUI {
  // Faz girişleri: şebeke göstergesi (yıldırım ikonlu), 1 = VAR
  static PHASE_ITEMS = [
    { key: 'faz1', id: 'ioFaz1' },
    { key: 'faz2', id: 'ioFaz2' },
    { key: 'faz3', id: 'ioFaz3' },
  ];
  // Emniyet/Sistem grubu: 1 = OK, 0 = ARIZA
  static FAULT_ITEMS = [
    { key: 'fazKoruma',   badgeId: 'ioFazKoruma',   iconId: 'ioIconFazKoruma',   onLabel: 'OK', offLabel: 'ARIZA' },
    { key: 'termik',      badgeId: 'ioTermik',      iconId: 'ioIconTermik',      onLabel: 'OK', offLabel: 'ARIZA' },
    { key: 'softStarter', badgeId: 'ioSoftStarter', iconId: 'ioIconSoftStarter', onLabel: 'OK', offLabel: 'ARIZA' },
    { key: 'basinc',      badgeId: 'ioBasinc',      iconId: 'ioIconBasinc',      onLabel: 'OK', offLabel: 'ARIZA' },
    { key: 'chiller',     badgeId: 'ioChiller',     iconId: 'ioIconChiller',     onLabel: 'OK', offLabel: 'ARIZA' },
  ];
  // Pozisyon grubu: fault değil, sadece durum
  static POSITION_ITEMS = [
    { key: 'selenoidYukari', badgeId: 'ioSelenoidYukari', iconId: 'ioIconSelenoidYukari', onLabel: 'AKTİF', offLabel: 'PASİF' },
    { key: 'selenoidAsagi',  badgeId: 'ioSelenoidAsagi',  iconId: 'ioIconSelenoidAsagi',  onLabel: 'AKTİF', offLabel: 'PASİF' },
  ];

  update(states) {
    SafetyIoUI.PHASE_ITEMS.forEach(item => this._setPhase(item, states[item.key]));
    SafetyIoUI.FAULT_ITEMS.forEach(item => this._setItem(item, states[item.key], 'ok', 'fault'));
    SafetyIoUI.POSITION_ITEMS.forEach(item => this._setItem(item, states[item.key], 'active', 'inactive'));
  }

  // BLE bağlantısı kesilince çağrılır — update({}) gibi hepsini "ARIZA/PASİF"
  // göstermez (yanıltıcı olur), gerçekten "--" placeholder'ına döner.
  reset() {
    SafetyIoUI.PHASE_ITEMS.forEach(item => {
      const el = document.getElementById(item.id);
      if (el) el.classList.remove('on', 'off');
    });
    [...SafetyIoUI.FAULT_ITEMS, ...SafetyIoUI.POSITION_ITEMS].forEach(item => {
      const badge = document.getElementById(item.badgeId);
      if (badge) { badge.textContent = '--'; badge.classList.remove('ok', 'fault', 'active', 'inactive'); }
      const icon = document.getElementById(item.iconId);
      if (icon) icon.classList.remove('ok', 'fault', 'active', 'inactive');
    });
  }

  _setPhase(item, value) {
    const el = document.getElementById(item.id);
    if (!el) return;
    const isOn = !!value;
    el.classList.toggle('on', isOn);
    el.classList.toggle('off', !isOn);
  }

  _setItem(item, value, onClass, offClass) {
    const isOn = !!value;
    const badge = document.getElementById(item.badgeId);
    if (badge) {
      badge.textContent = isOn ? item.onLabel : item.offLabel;
      badge.classList.remove(onClass, offClass);
      badge.classList.add(isOn ? onClass : offClass);
    }
    const icon = document.getElementById(item.iconId);
    if (icon) {
      icon.classList.remove(onClass, offClass);
      icon.classList.add(isOn ? onClass : offClass);
    }
  }
}

// Bir arıza oluşumunun tarih/saatini biçimlendirir + zaman satırını üretir:
// solda oluşturulma zamanı (durumu gösteren renkli noktayla), sağda normalleşme
// (giderilme) zamanı — henüz giderilmediyse "—". Hem liste bloklarında (LogsUI)
// hem detay penceresinde (LogInfoModal) aynı görünüm kullanılsın diye ortak.
function formatLogDate(value) {
  // ESP saati senkron olmadan (CMD_SAAT_AYARLA öncesi) loglanan kayıtlarda zaman_epoch
  // 0 gelebilir — bunu ham "01.01.1970" olarak göstermek yanıltıcı, "bilinmiyor" daha doğru.
  if (!value) return 'Zaman bilinmiyor';
  const d = new Date(value);
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function renderLogTimeRow(o) {
  const clearedText = o.clearedAt ? formatLogDate(o.clearedAt) : '—';
  const clearedClass = o.clearedAt ? 'log-time-col cleared' : 'log-time-col';
  return `<div class="log-time-row">
    <span class="log-time-col created"><span class="log-time-dot ${o.status}"></span>${formatLogDate(o.timestamp)}</span>
    <span class="${clearedClass}">${clearedText}</span>
  </div>`;
}

// =====================================================================
// ARIZA KAYITLARI (Sayfa 2) — cihazdan gelen arıza geçmişini gösterir
// Kayıt şekli: { code, type: 'temporary'|'permanent', status: 'active'|'cleared',
//                timestamp, clearedAt }. Liste çekimi sadece bunları içerir —
// açıklama ve çözüm metni burada TUTULMAZ, bir kayda tıklanınca ESP'den
// ISTEK_ARIZA_DETAY / ISTEK_ARIZA_COZUM ile anlık istenir (LogInfoModal).
// Aynı koda ait birden fazla oluşum tek blokta gruplanır, zamanlar alt alta
// listelenir (_groupByCode).
// =====================================================================
class LogsUI {
  // Kalıcı/geçici sekim ayrımı kalktı — geçmiş olmayan her hata "aktif" sayılır.
  // Geçici bir hata sadece kendiliğinden düzelince (durum=giderildi) geçmişe düşer.
  // Kalıcı bir hata ise durum=giderildi olsa BİLE resetlenmediyse aktifte kalır —
  // geçmişe düşmesi için durum=giderildi VE resetlendi=true birlikte gerekir.
  static _isHistorical(r) {
    if (r.type === 'permanent') return r.status !== 'active' && !!r.resetlendi;
    return r.status !== 'active';
  }
  static BUCKETS = {
    active:  r => !LogsUI._isHistorical(r),
    history: r => LogsUI._isHistorical(r),
  };

  constructor(loadingEl, ringFillEl, percentEl, progressEl, errorEl, errorTextEl, retryBtnEl, contentEl, tabPanels, clearHistoryBtnEl, navBadgeEl, onRetry) {
    this.loadingEl = loadingEl;
    this.ring = new RingProgress(ringFillEl, percentEl, progressEl);
    this.errorEl = errorEl;
    this.errorTextEl = errorTextEl;
    this.contentEl = contentEl;
    this.tabPanels = tabPanels; // { active: {panel, empty, list}, history: {...} }
    this.clearHistoryBtn = clearHistoryBtnEl;
    this.navBadge = navBadgeEl;
    this._bindTabs();
    retryBtnEl.addEventListener('click', () => onRetry());
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
    this.errorEl.style.display = 'none';
    this.contentEl.style.display = 'none';
  }

  // BLE bağlantısı kesilince çağrılır — bilinmeyen/eski bir duruma güvenmemek için
  // Log sekmesindeki durum baloncuğunu tamamen gizler.
  resetNavBadge() {
    if (!this.navBadge) return;
    this.navBadge.classList.remove('show', 'state-active', 'state-history', 'state-clear');
    this.navBadge.textContent = '';
  }

  // ESP'den her YANIT_ARIZA_KAYDI geldikçe çağrılır — halkayı ve "X / TOTAL" sayacını günceller.
  updateProgress(received, total) {
    this.ring.set(received, total);
  }

  // YANIT_ARIZA_KAYITLARI_BITTI geldiğinde beklenen sayıya ulaşılamamışsa gösterilir.
  showError(missingCount) {
    this.loadingEl.style.display = 'none';
    this.contentEl.style.display = 'none';
    this.errorEl.style.display = 'flex';
    if (this.errorTextEl) {
      this.errorTextEl.textContent = `${missingCount} kayıt alınamadı.`;
    }
  }

  render(records) {
    this.loadingEl.style.display = 'none';
    this.errorEl.style.display = 'none';
    this.contentEl.style.display = 'flex';
    // Yeni liste geldi — "Siliniyor…" bekleme durumundan çık.
    this.clearHistoryBtn.disabled = false;
    this.clearHistoryBtn.textContent = 'Tüm Geçmişi Sil';

    Object.entries(LogsUI.BUCKETS).forEach(([key, matches]) => {
      const { empty, list } = this.tabPanels[key];
      const groups = this._groupByCode(records.filter(matches));

      if (!groups.length) {
        empty.style.display = 'flex';
        list.style.display = 'none';
        if (key === 'history') this.clearHistoryBtn.style.display = 'none';
        return;
      }

      empty.style.display = 'none';
      list.style.display = 'flex';
      list.innerHTML = groups.map(g => this._renderGroup(g, key)).join('');
      if (key === 'history') this.clearHistoryBtn.style.display = 'block';
    });

    this._updateNavBadge(records);
  }

  // Alt navigasyondaki Log ikonunun durum baloncuğu: aktif arıza varsa kırmızı
  // (yanıp söner, sayı yok), sadece geçmiş varsa sarı (kaç farklı hata varsa
  // sayısı), hiç arıza yoksa yeşil (sabit).
  _updateNavBadge(records) {
    if (!this.navBadge) return;
    const activeCount = this._groupByCode(records.filter(r => !LogsUI._isHistorical(r))).length;
    const historyCount = this._groupByCode(records.filter(r => LogsUI._isHistorical(r))).length;

    this.navBadge.classList.remove('state-active', 'state-history', 'state-clear');
    this.navBadge.classList.add('show');
    if (activeCount > 0) {
      this.navBadge.classList.add('state-active');
      this.navBadge.textContent = '';
    } else if (historyCount > 0) {
      this.navBadge.classList.add('state-history');
      this.navBadge.textContent = String(historyCount);
    } else {
      this.navBadge.classList.add('state-clear');
      this.navBadge.textContent = '';
    }
  }

  // Aynı hata kodunun birden fazla oluşumunu tek blokta toplar — zamanlar
  // blok içinde alt alta listelenir (yeniden eskiye). Bloklar da en yeni
  // oluşumu üstte olacak şekilde sıralanır.
  _groupByCode(records) {
    const map = new Map();
    records.forEach(r => {
      if (!map.has(r.code)) map.set(r.code, { code: r.code, type: r.type, occurrences: [] });
      map.get(r.code).occurrences.push(r);
    });
    const groups = [...map.values()];
    groups.forEach(g => g.occurrences.sort((a, b) => b.timestamp - a.timestamp));
    groups.sort((a, b) => b.occurrences[0].timestamp - a.occurrences[0].timestamp);
    return groups;
  }

  // Aktif arızalar için uyarı üçgeni, giderilenler için onay ikonu — rozetlerin
  // yanında bir bakışta durumu ayırt etmeyi kolaylaştırır.
  static STATUS_ICONS = {
    active: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    cleared: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="8 12 11 15 16 9"/></svg>',
  };

  // Detay/çözüm metni burada gösterilmez — bloğa tıklanınca WeldmacApp,
  // ESP'den ISTEK_ARIZA_DETAY ile anlık ister (LogInfoModal).
  // Geçmişteki bir kayıt artık "durum" taşımaz (giderildi+resetlendi, iş bitti) —
  // rozet ve Resetle butonu sadece Aktif sekmesindeki kayıtlarda gösterilir.
  // bucketKey doğrudan render()'daki BUCKETS filtresinden geliyor (LogsUI._isHistorical) —
  // kalıcı bir hatanın durumu tek başına 'cleared' olsa bile resetlendi=false ise grup
  // hâlâ 'active' bucket'ında olur, o yüzden ham status yerine bucketKey'e güveniyoruz.
  _renderGroup(group, bucketKey) {
    const isActiveNow = bucketKey === 'active';
    const typeClass = group.type === 'permanent' ? 'type-permanent' : 'type-temporary';
    const timesHtml = group.occurrences.map(renderLogTimeRow).join('');

    let statusHtml = '';
    if (isActiveNow && group.type === 'permanent') {
      // Kalıcı hatada koşul hâlâ sürüyorsa Resetle anlamsız — sadece "Devam Ediyor" yazısı,
      // buton yok. Koşul geçtiyse (giderildi ama henüz resetlenmedi) buton çıkar.
      const conditionOngoing = group.occurrences[0].status === 'active';
      statusHtml = conditionOngoing
        ? `<span class="log-state-label ongoing">Devam Ediyor</span>`
        : `<span class="log-state-label resolved">Giderildi</span><button class="log-reset-btn" data-log-reset="${group.code}">Resetle</button>`;
    } else if (isActiveNow) {
      statusHtml = `<span class="log-badge active">AKTİF</span>`;
    }

    const occurrencesData = encodeURIComponent(JSON.stringify(group.occurrences));
    return `<div class="log-entry ${typeClass}" data-log-code="${group.code}" data-log-occurrences="${occurrencesData}">
      <div class="log-entry-header">
        <span class="log-icon ${isActiveNow ? 'active' : 'cleared'}">${LogsUI.STATUS_ICONS[isActiveNow ? 'active' : 'cleared']}</span>
        <span class="log-code">${group.code}</span>
        ${statusHtml}
      </div>
      <div class="log-times">${timesHtml}</div>
    </div>`;
  }
}

// =====================================================================
// YAZILIM GÜNCELLEME (Sayfa 4) — ESP'deki sürüm ile güncel sürümü karşılaştırır ve
// gerçek OTA aktarımını yapar: .bin dosyasını indirir, ~200 byte'lık parçalara
// bölüp CMD_OTA_PARCA ile sırayla gönderir, sonda CRC32 ile bütünlüğü doğrular.
// =====================================================================

// Sürüm bilgisi (tag) GitHub Release API'sinden alınıyor — bunun CORS'u sorunsuz.
// AMA .bin dosyasını Release'e "Attach binaries" ile eklersen indirme linki
// GitHub Releases/tag KULLANMIYORUZ — sürüm bilgisi ve .bin dosyası her zaman
// `main` branch'indeki SABİT bir yoldan, raw.githubusercontent.com üzerinden
// okunur (public repo için CORS'a tam izin veren tek GitHub adresi).
// Yeni bir sürüm çıkarken yapılması gereken TEK şey: bu iki dosyayı main'e
// commit'lemek (ikisi de aynı isimde kalır, üzerine yazılır):
//   weldmac/firmware/firmware.bin     -> güncel derlenmiş firmware
//   weldmac/firmware/version.json     -> { "version": "...", "date": "...", "notes": "..." }
const FIRMWARE_GITHUB_REPO = 'bilgehancirak/REDLIFT-MCI';
const FIRMWARE_BRANCH = 'main';
const FIRMWARE_DIR = 'weldmac/firmware';
const FIRMWARE_VERSION_URL = `https://raw.githubusercontent.com/${FIRMWARE_GITHUB_REPO}/${FIRMWARE_BRANCH}/${FIRMWARE_DIR}/version.json`;
const FIRMWARE_BIN_URL = `https://raw.githubusercontent.com/${FIRMWARE_GITHUB_REPO}/${FIRMWARE_BRANCH}/${FIRMWARE_DIR}/firmware.bin`;

// Standart CRC-32 (IEEE 802.3) — indirilen .bin bozulmadan geldiğini ESP'ye
// doğrulatmak için CMD_OTA_BITTI ile birlikte gönderilir.
function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// YANIT_OTA_HAZIR / YANIT_OTA_TAMAMLANDI payload'ının 2. byte'ı (hata kodu) — ESP
// başarısız olduğunda SEBEBİNİ bu koda göre bildirir. ESP tarafında bu tabloyla
// birebir aynı sayısal kodlar kullanılmalı (0 = hata yok, cihaz başarılıysa gönderilmez/dikkate alınmaz).
const OTA_ERROR_MESSAGES = {
  0x01: 'Yetersiz flash alanı',
  0x02: 'OTA zaten devam ediyor',
  0x03: 'Geçersiz toplam boyut bildirildi',
  0x04: 'OTA partition bulunamadı',
  0x05: 'Flash yazma hatası',
  0x06: 'CRC uyuşmadı — dosya bozuk gelmiş olabilir',
  0x07: 'Parça sırası hatası',
};
function otaErrorMessage(errorCode, fallback) {
  return OTA_ERROR_MESSAGES[errorCode] || fallback;
}

class FirmwareUpdateUI {
  // Cihazdan sürüm yanıtı için beklenecek azami süre.
  static DEVICE_VERSION_TIMEOUT_MS = 8000;
  // Tek bir CMD_OTA_PARCA'nın toplam BLE yazım boyutu = 4 (çerçeve başlığı: TYPE+ID_low+ID_high+LEN)
  // + 2 (parça no) + OTA_CHUNK_SIZE (ham veri) + 1 (checksum) = 242 byte, 244 MTU sınırının
  // altında. Bir grup (64 parça) = 64 x 235 = ~15 KB saf firmware verisi.
  static OTA_CHUNK_SIZE = 235;
  // ESP'nin kuyruğu bu kadarını art arda (onay beklemeden, Write Without Response ile)
  // alacak şekilde ayarlandı — grup bitince TEK bir onayla doğruluyoruz.
  static OTA_BATCH_SIZE = 64;
  static OTA_READY_TIMEOUT_MS = 8000;
  // Tamamlanma cevabı ESP'nin flash'a yazıp doğrulamasını beklediği için daha uzun.
  static OTA_COMPLETE_TIMEOUT_MS = 20000;
  // Bir grup (64 parça) gönderildikten sonra ESP'nin YANIT_OTA_PARCA_ALINDI ile
  // grubun tamamını işlediğini onaylamasını bekleriz — çok sayıda flash yazması
  // içerdiği için tek parçalık bekleyişten daha uzun tutuldu.
  static OTA_BATCH_ACK_TIMEOUT_MS = 8000;

  constructor(els, { onRequestVersion, onStartOta, onSendChunk, onFinishOta, onRequestConfirmation }) {
    // els: { loadingEl, errorEl, retryBtn, updatingEl, updatingLabelEl, contentEl,
    //        currentVersionEl, latestVersionEl, statusEl, updateBtn,
    //        progressPercentEl, progressRingFillEl, progressBytesEl }
    this.els = els;
    this.onRequestVersion = onRequestVersion; // () => ble.requestYazilimSurumu()
    this.onStartOta = onStartOta;             // (totalSize) => ble.startOta(totalSize)
    this.onSendChunk = onSendChunk;           // (chunkNo, bytes) => ble.sendOtaChunk(chunkNo, bytes)
    this.onFinishOta = onFinishOta;           // (crc32) => ble.finishOta(crc32)
    this.onRequestConfirmation = onRequestConfirmation; // () => fwUpdateConfirmModal.open()
    this.currentVersion = null;
    this.latestRelease = null; // { version, downloadUrl, size, notes }
    this._resolveDeviceVersion = null;
    this._resolveOtaReady = null;
    this._resolveOtaComplete = null;
    this._resolveOtaChunkAck = null;
    this._pendingBytes = null; // indirilip onay bekleyen firmware verisi

    this.ring = new RingProgress(this.els.progressRingFillEl, this.els.progressPercentEl, this.els.progressBytesEl);

    this.els.updateBtn.addEventListener('click', () => this._downloadAndConfirm());
    this.els.retryBtn.addEventListener('click', () => this._checkVersions());

    this._checkVersions();
  }

  // YANIT_YAZILIM_SURUMU gelince (_handleFrame'de) çağrılır. Test için: testFirmwareVersion('1.2.0')
  setCurrentVersion(version) {
    if (this._resolveDeviceVersion) this._resolveDeviceVersion(version);
  }

  // YANIT_OTA_HAZIR gelince çağrılır. errorCode: payload'ın 2. byte'ı (bkz. OTA_ERROR_MESSAGES).
  // Test için: testOtaHazir(true) veya testOtaHazir(false, 0x01)
  setOtaReady(success, errorCode = 0) {
    if (this._resolveOtaReady) this._resolveOtaReady(success, errorCode);
  }

  // YANIT_OTA_TAMAMLANDI gelince çağrılır. errorCode: payload'ın 2. byte'ı.
  // Test için: testOtaTamamlandi(true) veya testOtaTamamlandi(false, 0x06)
  setOtaComplete(success, errorCode = 0) {
    if (this._resolveOtaComplete) this._resolveOtaComplete(success, errorCode);
  }

  // YANIT_OTA_PARCA_ALINDI gelince çağrılır — chunkNo, o an biten GRUBUN son parça no'sudur.
  // Test için: testOtaParcaAlindi(63, true) (ilk grup 0..63 ise)
  setOtaChunkAck(chunkNo, success, errorCode = 0) {
    if (this._resolveOtaChunkAck) this._resolveOtaChunkAck(chunkNo, success, errorCode);
  }

  _fetchDeviceVersion() {
    return new Promise((resolve, reject) => {
      this._resolveDeviceVersion = resolve;
      this.onRequestVersion();
      setTimeout(() => reject(new Error('Cihazdan sürüm bilgisi alınamadı (zaman aşımı)')), FirmwareUpdateUI.DEVICE_VERSION_TIMEOUT_MS);
    });
  }

  _startOtaAndWaitReady(totalSize) {
    return new Promise((resolve, reject) => {
      this._resolveOtaReady = (success, errorCode) => success
        ? resolve()
        : reject(new Error(otaErrorMessage(errorCode, 'ESP OTA başlatmayı reddetti')));
      this.onStartOta(totalSize);
      setTimeout(() => reject(new Error('ESP OTA hazır cevabı vermedi (zaman aşımı)')), FirmwareUpdateUI.OTA_READY_TIMEOUT_MS);
    });
  }

  _finishOtaAndWaitComplete(checksum) {
    return new Promise((resolve, reject) => {
      this._resolveOtaComplete = (success, errorCode) => success
        ? resolve()
        : reject(new Error(otaErrorMessage(errorCode, 'ESP doğrulaması başarısız (CRC uyuşmadı olabilir)')));
      this.onFinishOta(checksum);
      setTimeout(() => reject(new Error('ESP tamamlanma onayı vermedi (zaman aşımı)')), FirmwareUpdateUI.OTA_COMPLETE_TIMEOUT_MS);
    });
  }

  // Bir grubun (OTA_BATCH_SIZE parçaya kadar) SON parçasının onayını bekler. Gruptaki parçaların
  // hepsi bu çağrılmadan ÖNCE art arda (onaysız) gönderilmiş olur; ESP grubu tamamen
  // işleyip TEK bir YANIT_OTA_PARCA_ALINDI ile (parca_no = gruptaki son parça no)
  // cevap verince bir sonraki grup gönderilir.
  _waitBatchAck(lastChunkNo) {
    return new Promise((resolve, reject) => {
      this._resolveOtaChunkAck = (ackChunkNo, success, errorCode) => {
        if (ackChunkNo !== lastChunkNo) return; // geç kalmış/başka bir grubun onayı — yoksay
        success ? resolve() : reject(new Error(otaErrorMessage(errorCode, `ESP #${lastChunkNo}. parçaya kadar olan grubu kabul etmedi`)));
      };
      setTimeout(() => reject(new Error(`ESP grup onayı vermedi (zaman aşımı, son parça #${lastChunkNo})`)), FirmwareUpdateUI.OTA_BATCH_ACK_TIMEOUT_MS);
    });
  }

  // weldmac/firmware/version.json'u okur — o an main'e commit'lenmiş firmware.bin'in
  // sürüm bilgisini verir. .bin'in kendisi sabit FIRMWARE_BIN_URL adresinden inecek.
  async _fetchLatestVersion() {
    const res = await fetch(FIRMWARE_VERSION_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('version.json okunamadı: HTTP ' + res.status);
    const data = await res.json();

    const version = String(data.version || '');
    if (!version) throw new Error('version.json içinde "version" alanı bulunamadı');

    return { version, downloadUrl: FIRMWARE_BIN_URL, size: data.size || null, notes: data.notes || '' };
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
    this.latestRelease = latestResult.value; // { version, downloadUrl, size, notes }
    this.els.currentVersionEl.textContent = this.currentVersion;
    this.els.latestVersionEl.textContent = this.latestRelease.version;
    this.els.contentEl.style.display = 'flex';
    this._updateStatus();
  }

  _updateStatus() {
    if (!this.currentVersion || !this.latestRelease) return;
    if (this._compareVersions(this.currentVersion, this.latestRelease.version) < 0) {
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

  _setStage(text) {
    this.els.updatingLabelEl.textContent = text;
  }

  static _formatKB(bytes) {
    return (bytes / 1024).toFixed(bytes < 1024 * 10 ? 1 : 0);
  }

  // pct: yüzde (halkanın dolum oranı). sentBytes/totalBytes: merkezdeki "x / y KB" yazısı.
  _setProgress(pct, sentBytes, totalBytes) {
    this.ring.setPercent(pct);
    this.ring.setCount(`${FirmwareUpdateUI._formatKB(sentBytes)} / ${FirmwareUpdateUI._formatKB(totalBytes)} KB`);
  }

  // "GÜNCELLE" butonuna basılınca çağrılır. ÖNCE dosyayı indirir — ancak indirme
  // başarılı olursa kullanıcıdan onay istenir (indiremiyorsak ESP'yi hiç meşgul
  // etmeye gerek yok). Onaydan sonra startUpdate() bu indirilmiş veriyle devam eder.
  async _downloadAndConfirm() {
    this.els.contentEl.style.display = 'none';
    this.els.updatingEl.style.display = 'flex';
    this._setStage('İndiriliyor…');
    this._setProgress(0, 0, 0);

    let bytes;
    try {
      const res = await fetch(this.latestRelease.downloadUrl, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      bytes = new Uint8Array(await res.arrayBuffer());
      if (this.latestRelease.size && bytes.length !== this.latestRelease.size) {
        throw new Error(`Beklenen boyut ${this.latestRelease.size} byte, inen ${bytes.length} byte — dosya bozuk olabilir`);
      }
    } catch (downloadErr) {
      console.error('Güncel yazılım indirilemedi:', downloadErr);
      this.els.updatingEl.style.display = 'none';
      this.els.contentEl.style.display = 'flex';
      this.els.statusEl.textContent = 'Güncel yazılım indirilemiyor';
      this.els.statusEl.className = 'fw-status error';
      this.els.updateBtn.disabled = false; // tekrar denemesine izin ver
      return;
    }

    // İndirme başarılı — şimdi kullanıcıdan onay iste, ESP'ye henüz dokunmadık.
    this._pendingBytes = bytes;
    this.els.updatingEl.style.display = 'none';
    this.els.contentEl.style.display = 'flex';
    this.onRequestConfirmation();
  }

  // Kullanıcı onay modalında "Güncelle" dedikten sonra çağrılır — dosya zaten
  // indirilmiş durumda, buradan itibaren ESP'ye gönderim başlar.
  startUpdate() {
    const bytes = this._pendingBytes;
    this._pendingBytes = null;
    if (!bytes) return; // savunma amaçlı — normal akışta hep dolu olmalı
    this._sendToEsp(bytes);
  }

  // İndirilmiş firmware'i ~200 byte'lık parçalara bölüp sırayla (64'lük gruplar
  // hâlinde) CMD_OTA_PARCA ile gönderir, sonda CRC32 ile bütünlüğü doğrulatır.
  async _sendToEsp(bytes) {
    this.els.contentEl.style.display = 'none';
    this.els.updatingEl.style.display = 'flex';
    this._setProgress(0, 0, bytes.length);

    try {
      const checksum = crc32(bytes);

      this._setStage('ESP hazırlanıyor…');
      await this._startOtaAndWaitReady(bytes.length);

      this._setStage('Gönderiliyor…');
      const chunkSize = FirmwareUpdateUI.OTA_CHUNK_SIZE;
      const batchSize = FirmwareUpdateUI.OTA_BATCH_SIZE;
      const totalChunks = Math.ceil(bytes.length / chunkSize);
      for (let batchStart = 0; batchStart < totalChunks; batchStart += batchSize) {
        const batchEnd = Math.min(batchStart + batchSize, totalChunks); // dışlayıcı (exclusive) uç
        for (let i = batchStart; i < batchEnd; i++) {
          const chunk = bytes.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, bytes.length));
          await this.onSendChunk(i, chunk); // gruptaki parçalar onay beklemeden art arda gider
        }
        await this._waitBatchAck(batchEnd - 1); // grubun SON parçasının onayını bekle
        const sentBytes = Math.min(batchEnd * chunkSize, bytes.length);
        const pct = Math.round((sentBytes / bytes.length) * 100);
        this._setProgress(pct, sentBytes, bytes.length);
      }

      this._setStage('Doğrulanıyor…');
      await this._finishOtaAndWaitComplete(checksum);

      this.els.updatingEl.style.display = 'none';
      this.els.contentEl.style.display = 'flex';
      this.currentVersion = this.latestRelease.version;
      this.els.currentVersionEl.textContent = this.currentVersion;
      this._updateStatus();
    } catch (err) {
      console.error('Güncelleme başarısız:', err);
      this.els.updatingEl.style.display = 'none';
      this.els.contentEl.style.display = 'flex';
      this.els.statusEl.textContent = 'Güncelleme başarısız: ' + err.message;
      this.els.statusEl.className = 'fw-status error';
      this.els.updateBtn.disabled = false; // tekrar denemesine izin ver
    }
  }
}

// =====================================================================
// UYGULAMA — tüm bileşenleri oluşturur ve birbirine bağlar
// =====================================================================
class WeldmacApp {
  // Hedef sıcaklığa "ulaşıldı" sayılması için izin verilen fark (°C)
  static TEMP_REACHED_TOLERANCE_C = 2;

  // Sıcaklık/set isteği yanıt vermezse tekrar deneme aralığı
  static SICAKLIK_SET_RETRY_INTERVAL_MS = 1000;

  // Adım durumu isteği yanıt vermezse tekrar deneme aralığı
  static ADIM_DURUMU_RETRY_INTERVAL_MS = 1000;

  // Self Tune ekranı açıkken H4/H6/H7/H9'un güncel değerlerini görebilmek için
  // parametrelerin sessizce yeniden istenme aralığı (bkz. _startSelfTunePidPoll)
  static SELF_TUNE_PID_POLL_INTERVAL_MS = 5000;

  // "Self Tune Bitir" sonrası, ESP'nin C10=0 yazımını gerçekten işlemesi için
  // beklenen geri sayım süresi (bkz. _handleSelfTuneCoilChange, SelfTuneScreen.showFinishing)
  static SELF_TUNE_FINISH_DELAY_SECONDS = 5;

  constructor() {
    this.lastTemps = [];
    this._sicaklikSetRetryTimer = null;
    this._adimDurumuRetryTimer = null;
    this.tempHasDecimal = true; // H28 sensör tipi öğrenilene kadar varsayılan
    this._currentPageIndex = 0; // yeni arıza gelince anasayfadan Log'a otomatik atlamak için
    this._skipNextLogsFetch = false; // otomatik yönlendirmede gereksiz tam liste çekimini atlamak için
    // STATUS_CANLI_IZLEME akışını birden fazla tüketici isteyebilir (Canlı İzle
    // paneli + Self Tune ilerleme takibi) — ESP'ye sadece kimse istemediğinde
    // DURDUR, en az bir istekli varken BAŞLA gönderilir (bkz. _wantLiveStream).
    this._liveStreamWanters = new Set();
    this._selfTuneActive = false;
    // "Bitir" butonuna basılınca true olur — C10'un kullanıcı tarafından mı yoksa
    // cihazın kendisi tarafından mı 0'a döndürüldüğünü ayırt etmek için (bkz.
    // _handleSelfTuneCoilChange, SelfTuneScreen.showCompleted).
    this._selfTuneStoppedByUser = false;
    // I3'ün (Self tune durum kodu) en son bilinen değeri — C10 0'a dönünce
    // gerçekten bir hesaplama aşamasından (2 veya 3) geçilip geçilmediğini,
    // yani cihazın işi gerçekten tamamlayıp tamamlamadığını anlamak için.
    this._lastSelfTuneStageCode = 0;
    // "Bitir" sonrası geri sayım sürerken true — bu sürede gelen TÜM C10
    // değerleri _handleSelfTuneCoilChange'in en başında yok sayılır (bkz. orada).
    this._selfTuneFinishing = false;

    this.pager = new Pager(
      document.getElementById('pager'),
      document.getElementById('bottomNav'),
      (index) => this._onPageChange(index)
    );

    this.connUI = new ConnUI(
      document.getElementById('connStatusLed'),
      document.getElementById('txLed'),
      document.getElementById('rxLed')
    );

    this.connectionScreen = new ConnectionScreen(
      document.getElementById('connectionScanBtn'),
      document.getElementById('connectionKnownBox'),
      document.getElementById('connectionKnownList'),
      {
        onScan: () => this.ble.requestDevice(),
        onConnectKnown: (device) => this.ble.connectToDevice(device),
      }
    );

    this.currentPhase = 0;
    this.preheatBtn = document.getElementById('btnPreheat');
    this.processBtn = document.getElementById('btnProcess');
    this.stopBtn = document.getElementById('btnStop');
    this.startButtonsWrap = document.getElementById('startButtonsWrap');

    this.processScreen = new ProcessScreen({
      stepLabel: document.getElementById('processStepLabel'),
      currentTemp: document.getElementById('processCurrentTemp'),
      targetRow: document.getElementById('processTargetRow'),
      targetTemp: document.getElementById('processTargetTemp'),
      targetTolerance: document.getElementById('processTargetTolerance'),
      remainingWrap: document.getElementById('processRemainingWrap'),
      remaining: document.getElementById('processRemainingTime'),
    });

    this.safetyIoUI = new SafetyIoUI();

    this.infoPopup = new InfoPopup(
      document.getElementById('infoOverlay'),
      document.getElementById('infoPopupTitle'),
      document.getElementById('infoPopupBody'),
      document.getElementById('closeInfoPopup')
    );

    this.liveMonitorUI = new LiveMonitorUI(
      document.getElementById('liveMonitorOverlay'),
      document.getElementById('closeLiveMonitor'),
      document.getElementById('liveMonitorBody'),
      {
        onOpen: () => this._wantLiveStream('monitor'),
        onClose: () => this._unwantLiveStream('monitor'),
      }
    );

    this.selfTuneScreen = new SelfTuneScreen(
      {
        content: document.getElementById('selfTuneContent'),
        tempValue: document.getElementById('selfTuneTempValue'),
        chart: document.getElementById('selfTuneChart'),
        powerValue: document.getElementById('selfTunePowerValue'),
        powerFill: document.getElementById('selfTunePowerFill'),
        stageRow: document.getElementById('selfTuneStageRow'),
        warnInline: document.getElementById('selfTuneWarnInline'),
        completeBanner: document.getElementById('selfTuneCompleteBanner'),
        finishBtn: document.getElementById('selfTuneFinishBtn'),
        finishLabel: document.getElementById('selfTuneFinishLabel'),
        finishingLoading: document.getElementById('selfTuneFinishingLoading'),
        finishingRingFill: document.getElementById('selfTuneFinishingRingFill'),
        finishingPercent: document.getElementById('selfTuneFinishingPercent'),
        finishingCount: document.getElementById('selfTuneFinishingCount'),
      },
      () => {
        this._selfTuneStoppedByUser = true;
        this.settingsUI.writeSelfTuneCoil(0);
      }
    );

    this.settingsUI = new SettingsUI();

    this.settingsOverlay = new SettingsOverlay(
      document.getElementById('settingsOverlay'),
      document.getElementById('settingsOverlayTitle'),
      document.getElementById('closeSettingsOverlay'),
      document.getElementById('settingsLoading'),
      document.getElementById('settingsProgressRingFill'),
      document.getElementById('settingsProgressPercent'),
      document.getElementById('settingsLoadingProgress'),
      document.getElementById('settingsError'),
      document.getElementById('settingsErrorText'),
      document.getElementById('settingsRetryBtn'),
      document.getElementById('settingsOverlayBody'),
      () => this._openSettingsPanel()
    );
    this._receivedParamKeys = new Set();

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

    this.logInfoModal = new LogInfoModal(
      document.getElementById('logInfoOverlay'),
      document.getElementById('logInfoTitle'),
      document.getElementById('logInfoBody'),
      document.getElementById('closeLogInfo')
    );
    this.resetConfirmModal = new ResetConfirmModal(
      document.getElementById('resetConfirmOverlay'),
      document.getElementById('closeResetConfirm'),
      document.getElementById('resetConfirmCancel'),
      document.getElementById('resetConfirmOk'),
      (code) => this.ble.resetAriza(code)
    );
    document.addEventListener('click', (e) => {
      const resetBtn = e.target.closest('.log-reset-btn');
      if (resetBtn) {
        this.resetConfirmModal.open(resetBtn.dataset.logReset);
        return; // resetleme sırasında kayıt detayını açma
      }
      const solutionBtn = e.target.closest('.log-solution-btn');
      if (solutionBtn) {
        const code = solutionBtn.dataset.logSolution;
        this.logInfoModal.showSolutionLoading(code);
        this.ble.requestArizaCozum(code);
        return;
      }
      const entry = e.target.closest('.log-entry');
      if (!entry) return;
      const code = entry.dataset.logCode;
      const occurrences = JSON.parse(decodeURIComponent(entry.dataset.logOccurrences));
      this.logInfoModal.open(code, occurrences);
      this.ble.requestArizaDetay(code);
    });

    // Bir parametre input/select'i değişince otomatik olarak ESP'ye yazma isteği gönder.
    document.addEventListener('change', (e) => {
      const el = e.target;
      if (!el.matches('.param-input, .param-select')) return;
      this._writeParam(el);
    });

    document.getElementById('tempSettingsBtn').addEventListener('click', () => this._openSettingsPanel(1));
    document.getElementById('tempInfoBtn').addEventListener('click', () => {
      this.infoPopup.open(1, this.lastTemps);
      this.ble.requestEndaBaglanti();
    });
    document.getElementById('tempLiveBtn').addEventListener('click', () => this.liveMonitorUI.open());

    // Bilgi/ayarlar kutucukları varsayılan gizli — ok tıklanınca açılır, dışarıya
    // tıklanınca (ya da tekrar oka basılınca) kapanır.
    const tempActionsToggle = document.getElementById('tempActionsToggle');
    const tempActionsGroup = document.getElementById('tempActionsGroup');
    tempActionsToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      tempActionsGroup.classList.toggle('show');
      tempActionsToggle.classList.toggle('open');
    });
    document.addEventListener('click', (e) => {
      if (!tempActionsGroup.classList.contains('show')) return;
      if (tempActionsGroup.contains(e.target) || tempActionsToggle.contains(e.target)) return;
      tempActionsGroup.classList.remove('show');
      tempActionsToggle.classList.remove('open');
    });

    this.logsUI = new LogsUI(
      document.getElementById('logsLoading'),
      document.getElementById('logsProgressRingFill'),
      document.getElementById('logsProgressPercent'),
      document.getElementById('logsLoadingProgress'),
      document.getElementById('logsError'),
      document.getElementById('logsErrorText'),
      document.getElementById('logsRetryBtn'),
      document.getElementById('logsContent'),
      {
        active:  { panel: document.getElementById('logsPanel-active'),  empty: document.getElementById('logsEmpty-active'),  list: document.getElementById('logsList-active') },
        history: { panel: document.getElementById('logsPanel-history'), empty: document.getElementById('logsEmpty-history'), list: document.getElementById('logsList-history') },
      },
      document.getElementById('logClearHistoryBtn'),
      document.getElementById('logNavBadge'),
      () => this._openLogsPanel()
    );
    this._logRecords = [];
    this._expectedLogCount = null;
    this.logsUI.showLoading();

    this.ble = new BleLink({
      onConnectionChange: (connected) => {
        this.connUI.update(connected);
        if (connected) {
          document.body.classList.remove('ble-disconnected');
          this.pager.goToPage(0); // bağlanınca (ilk bağlantı ya da yeniden bağlanma) hep anasayfadan başla
          this.ble.sendSaat();
          if (this.lastTemps.length === 0) {
            this._requestSicaklikSetWithRetry();
          }
          // C10'u (Self Tune) öğrenmenin tek yolu daha önce Ayarlar panelini
          // açmaktı — kullanıcı hiç açmadan Self Tune zaten çalışıyor olabilir
          // (önceki oturumdan kalmış, NFC/EndaLink ile başlatılmış vb.). Hangi
          // sayfada olunursa olsun her bağlantıda (ilk bağlantı + her yeniden
          // bağlanma) sessizce tüm parametreler istenip C10 anında öğrenilir —
          // aktifse _handleSelfTuneCoilChange otomatik Self Tune ekranına geçirir.
          this.ble.requestAllParams();
        } else {
          this._stopSicaklikSetRetry();
          this._stopAdimDurumuRetry();
          this._handleDisconnect();
        }
      },
      onFrame: (frame) => this._handleFrame(frame),
      onTx: () => this.connUI.flashTx(),
      onRx: () => this.connUI.flashRx(),
    });

    // BleLink'ten SONRA oluşturuluyor: constructor'ı hemen _checkVersions() çağırıp
    // senkron olarak onRequestVersion()'ı tetikliyor — this.ble o an zaten hazır olmalı.
    this.firmwareUpdateUI = new FirmwareUpdateUI(
      {
        loadingEl: document.getElementById('fwLoading'),
        errorEl: document.getElementById('fwError'),
        retryBtn: document.getElementById('fwRetryBtn'),
        updatingEl: document.getElementById('fwUpdating'),
        updatingLabelEl: document.getElementById('fwUpdatingLabel'),
        contentEl: document.getElementById('fwContent'),
        currentVersionEl: document.getElementById('fwCurrentVersion'),
        latestVersionEl: document.getElementById('fwLatestVersion'),
        statusEl: document.getElementById('fwStatus'),
        updateBtn: document.getElementById('fwUpdateBtn'),
        progressPercentEl: document.getElementById('fwProgressPercent'),
        progressRingFillEl: document.getElementById('fwProgressRingFill'),
        progressBytesEl: document.getElementById('fwProgressBytes'),
      },
      {
        onRequestVersion: () => this.ble.requestYazilimSurumu(),
        onStartOta: (totalSize) => this.ble.startOta(totalSize),
        onSendChunk: (chunkNo, bytes) => this.ble.sendOtaChunk(chunkNo, bytes),
        onFinishOta: (checksum) => this.ble.finishOta(checksum),
        onRequestConfirmation: () => this.fwUpdateConfirmModal.open(),
      }
    );
    this.fwUpdateConfirmModal = new FwUpdateConfirmModal(
      document.getElementById('fwUpdateConfirmOverlay'),
      document.getElementById('closeFwUpdateConfirm'),
      document.getElementById('fwUpdateConfirmCancel'),
      document.getElementById('fwUpdateConfirmOk'),
      () => this.firmwareUpdateUI.startUpdate()
    );
    this.factoryResetConfirmModal = new FactoryResetConfirmModal(
      document.getElementById('factoryResetConfirmOverlay'),
      document.getElementById('factoryResetConfirmDesc'),
      document.getElementById('closeFactoryResetConfirm'),
      document.getElementById('factoryResetConfirmCancel'),
      document.getElementById('factoryResetConfirmOk'),
      (kind) => this._sendFactoryReset(kind)
    );
    this.alertModal = new AlertModal(
      document.getElementById('alertOverlay'),
      document.getElementById('alertTitle'),
      document.getElementById('alertMessage'),
      document.getElementById('closeAlert'),
      document.getElementById('alertOkBtn')
    );

    this._bindGlobalUI();
    this._exposeTestHelpers();

    this.ble.tryAutoReconnect();
  }

  _bindGlobalUI() {
    document.getElementById('homeBtn').addEventListener('click', () => {
      this.ble.disconnect();
      window.location.href = 'https://bilgehancirak.github.io/REDLIFT-MCI/';
    });

    // Sekme/tarayıcı kapanınca BLE bağlantısını temiz şekilde kes — böylece ESP,
    // bağlantı kopukluğunu bir "supervision timeout" bekleyip anlamak yerine hemen fark eder.
    window.addEventListener('pagehide', () => this.ble.disconnect());

    document.getElementById('btnPreheat').addEventListener('click', () => this.ble.sendEmir(BleLink.CMD_PREHEAT_START));
    document.getElementById('btnProcess').addEventListener('click', () => this.ble.sendEmir(BleLink.CMD_PROCESS_START));
    document.getElementById('btnStop').addEventListener('click', () => this.ble.sendEmir(BleLink.CMD_STOP));

    document.getElementById('logClearHistoryBtn').addEventListener('click', (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Siliniyor…';
      this.ble.clearArizaGecmisi();
    });

    document.getElementById('factoryResetGeneralBtn').addEventListener('click', () => this.factoryResetConfirmModal.open('general'));
    document.getElementById('factoryResetProfileBtn').addEventListener('click', () => this.factoryResetConfirmModal.open('profile'));
  }

  // STATUS_CANLI_IZLEME akışını isteyen bir tüketici eklenince çağrılır (bkz.
  // liveMonitorUI ve _handleSelfTuneCoilChange). Akış zaten en az bir istekli
  // tarafından açıksa ESP'ye tekrar BAŞLA gönderilmez.
  _wantLiveStream(key) {
    const wasEmpty = this._liveStreamWanters.size === 0;
    this._liveStreamWanters.add(key);
    if (wasEmpty && this.ble.connected) this.ble.requestCanliIzlemeBasla();
  }

  // Bir tüketici akışı istemeyi bırakınca çağrılır — geriye başka istekli
  // kalmadıysa ESP'ye DURDUR gönderilir (gereksiz sürekli yayın olmasın diye).
  _unwantLiveStream(key) {
    this._liveStreamWanters.delete(key);
    if (this._liveStreamWanters.size === 0 && this.ble.connected) this.ble.requestCanliIzlemeDurdur();
  }

  // C10 (Self tune kontrol seçimi) her değiştiğinde çağrılır — hem ESP'den gelen
  // gerçek değer için (_handleFrame/YANIT_PARAMETRE) hem de kullanıcının yerel
  // yazması için (_writeParam) aynı yoldan geçer. Self Tune aktifleşince: (1)
  // pager/alt navigasyon gizlenip tam ekran SelfTuneScreen açılır (body.self-tune-mode),
  // (2) I0/I1/I3 takibi için canlı akış istenir, (3) H4/H6/H7/H9'un cihazın kendi
  // hesapladığı yeni değerlerini görebilmek için periyodik parametre sorgusu başlar.
  //
  // Aktif olmaktan çıkarken (C10 → 0) iki farklı sebep olabilir: (a) kullanıcı
  // "Self Tune Bitir"e bastı (_selfTuneStoppedByUser=true, bkz. SelfTuneScreen
  // constructor'ındaki onFinish), ya da (b) cihaz işi kendiliğinden bitirip C10'u
  // sıfırladı. (b) durumunda — ve en son görülen I3 gerçekten bir hesaplama
  // aşamasındaysa (2 veya 3, sadece "başlangıç sıcaklığı yüksek" beklemesi (1)
  // değil) — ekranı hemen kapatmak yerine "Self Tune Tamamlandı" onayı gösterilir.
  //
  // (a) durumunda da ekran HEMEN kapanmaz: bizim C10=0 yazmamız iyimser bir
  // yerel güncelleme, ESP bunu henüz gerçekten işlememiş olabilir — bu yüzden
  // hemen kapatırsak, ESP'nin az sonra göndereceği (henüz işlenmemiş, eski) C10=1
  // yankısı bu fonksiyonu tekrar tetikleyip ekranı yeniden açtırır (yanıp sönme).
  // Bunun yerine birkaç saniyelik bir geri sayım gösterilir (bkz. showFinishing)
  // ve bu süre boyunca _selfTuneFinishing guard'ı gelen TÜM C10 değerlerini yok
  // sayar; süre dolunca ekran gerçekten kapanır.
  _handleSelfTuneCoilChange(value) {
    if (this._selfTuneFinishing) return; // "Bitir" sonrası geri sayım sürerken gelen eski/gecikmeli yankılar
    const isActive = value === 1;
    if (isActive === this._selfTuneActive) return;
    this._selfTuneActive = isActive;

    if (isActive) {
      this._selfTuneStoppedByUser = false;
      this._lastSelfTuneStageCode = 0;
      // Self Tune Başlat butonu Ayarlar panelinin (PID sekmesi) içinde — o panel
      // .settings-overlay olarak fixed+z-index:200 ile zaten üstte duruyor.
      // self-tune-screen z-index:350 ile üstüne çıkar ama Ayarlar paneli açık
      // KALIRSA, Self Tune bitip bu ekran kapanınca kullanıcı beklenmedik şekilde
      // yine Ayarlar panelinin içinde bulur kendini — o yüzden burada da kapatılır.
      this.settingsOverlay.close();
      document.body.classList.add('self-tune-mode');
      this.selfTuneScreen.reset();
      this._wantLiveStream('selftune');
      this._startSelfTunePidPoll();
      return;
    }

    this._unwantLiveStream('selftune');
    this._stopSelfTunePidPoll();
    const completedByDevice = !this._selfTuneStoppedByUser
      && (this._lastSelfTuneStageCode === 2 || this._lastSelfTuneStageCode === 3);
    if (completedByDevice) {
      this.selfTuneScreen.showCompleted(() => this._exitSelfTuneMode());
    } else {
      this._selfTuneFinishing = true;
      this.selfTuneScreen.showFinishing(WeldmacApp.SELF_TUNE_FINISH_DELAY_SECONDS, () => {
        this._selfTuneFinishing = false;
        this._exitSelfTuneMode();
      });
    }
  }

  _exitSelfTuneMode() {
    document.body.classList.remove('self-tune-mode');
  }

  // H4/H6/H7/H9 gibi PID register'ları self tune sırasında cihaz tarafından
  // otomatik hesaplanıp yazılıyor — ESP bunları kendiliğinden anons etmeyebilir,
  // bu yüzden Self Tune ekranı açıkken güncel değerlerini görebilmek için düzenli
  // aralıklarla tüm parametreler sessizce (Ayarlar paneli açılmadan) yeniden istenir.
  _startSelfTunePidPoll() {
    this._stopSelfTunePidPoll();
    this._selfTunePidPollTimer = setInterval(() => {
      if (this.ble.connected) this.ble.requestAllParams();
    }, WeldmacApp.SELF_TUNE_PID_POLL_INTERVAL_MS);
  }
  _stopSelfTunePidPoll() {
    if (this._selfTunePidPollTimer) {
      clearInterval(this._selfTunePidPollTimer);
      this._selfTunePidPollTimer = null;
    }
  }

  _handleFrame(frame) {
    if (frame.type === BleLink.TYPE_DURUM) {
      if (frame.id === BleLink.STATUS_SICAKLIK) {
        // payload: [enda_sayısı(1B)] + her ENDA için [current_low, current_high, target_low, target_high, connected(1B)]
        const endaCount = frame.payload[0];
        const temps = [];
        const scale = this.tempHasDecimal ? 10 : 1; // H28 sensör tipi "ondalıklı" değilse ham değer aynen kullanılır
        for (let i = 0; i < endaCount; i++) {
          const offset = 1 + i * 5;
          const currentRaw = (frame.payload[offset] | (frame.payload[offset + 1] << 8)) << 16 >> 16;
          const targetRaw  = (frame.payload[offset + 2] | (frame.payload[offset + 3] << 8)) << 16 >> 16;
          const isConnected = frame.payload[offset + 4] === 1;
          temps.push({ current: currentRaw / scale, target: targetRaw / scale, connected: isConnected });
        }
        this.lastTemps = temps;
        this._stopSicaklikSetRetry(); // veri geldi, artık sormaya gerek yok
        if (temps[0]) {
          this.processScreen.updateCurrentTemp(temps[0].current);
          // Proses fazında hedef sıcaklığı STATUS_ADIM_DURUMU (adım bazlı) belirliyor;
          // diğer fazlarda ENDA'nın o anki SET değeri burada gösteriliyor.
          if (this.currentPhase !== 2) this.processScreen.updateIdleTarget(temps[0].target);
        }
        this.infoPopup.refresh(temps);
        this._updateModeButtons();
      } else if (frame.id === BleLink.STATUS_FAZ_DEGISTI) {
        this.currentPhase = frame.payload[0];
        this._updateModeButtons();
        this._updateProcessSection();
      } else if (frame.id === BleLink.STATUS_ADIM_DURUMU) {
        this._stopAdimDurumuRetry(); // veri geldi, artık sormaya gerek yok
        // Öz-iyileşme: adım durumu verisi sadece ENDA gerçekten PROSES'teyken gelir.
        // Bağlantı kopup yeniden kurulunca arada STATUS_FAZ_DEGISTI kaçırılmış olabilir
        // ve currentPhase yanlışlıkla PROSES değil kalabilir — bu veri geldiğinde
        // düzeltiyoruz, böylece proses bilgisi (Anasayfa'daysak hemen görünür) doğru gösterilir.
        if (this.currentPhase !== 2) {
          this.currentPhase = 2;
          this._updateModeButtons();
          this._updateProcessSection();
        }
        // payload (8 byte): [adım_no(1B), toplam_adım(1B), kalan_süre_low(1B), kalan_süre_high(1B),
        //   hedef_sicaklik_low(1B), hedef_sicaklik_high(1B), tolerans_low(1B), tolerans_high(1B)]
        const [stepNo, totalSteps, remLow, remHigh, targetLow, targetHigh, tolLow, tolHigh] = frame.payload;
        const remainingSeconds = remLow | (remHigh << 8);
        const targetRaw = (targetLow | (targetHigh << 8)) << 16 >> 16;
        const toleranceRaw = tolLow | (tolHigh << 8);
        const scale = this.tempHasDecimal ? 10 : 1;
        // Ayarlar'dan bilinen (kullanıcının bu adım için girdiği) tam süre — yeni adıma
        // geçişte ekranı ESP'nin ilk kalan_süre'sini beklemeden hemen başlatmak için
        // (bkz. ProcessScreen.updateStep). Settings hiç açılmadıysa cache boş olur,
        // bu durumda ProcessScreen normal şekilde ESP'nin değerine düşer.
        const cachedDuration = this.settingsUI._cachedValue(getProfileStepRegs(stepNo).time.addr, false, null);
        this.processScreen.updateStep({
          stepNo, totalSteps, remainingSeconds,
          targetTemp: targetRaw / scale,
          tolerance: toleranceRaw / scale,
          configuredDuration: cachedDuration !== null ? Number(cachedDuration) : null,
        });
      } else if (frame.id === BleLink.STATUS_GIRISLER) {
        // payload (10 byte, her biri 0/1): faz1,faz2,faz3,fazKoruma,termik,softStarter,basinc,selenoidYukari,selenoidAsagi,chiller
        const [faz1, faz2, faz3, fazKoruma, termik, softStarter, basinc, selenoidYukari, selenoidAsagi, chiller] = frame.payload;
        this.safetyIoUI.update({ faz1, faz2, faz3, fazKoruma, termik, softStarter, basinc, selenoidYukari, selenoidAsagi, chiller });
      } else if (frame.id === BleLink.STATUS_ARIZA_DEGISTI) {
        // Bir arızanın status biti (AKTIF/RESETLENMIS) değişince ESP tarafından anlık
        // gönderilir — Log sayfası açıkken kullanıcı sayfadan çıkmadan güncellensin diye.
        // Heartbeat'i yok, ESP bunu güvence için 10ms arayla 2 kez gönderiyor
        // (_sendFrameTwice) — bu yüzden eşleştirme idempotent olmalı: aynı paket iki kez
        // gelince de kayıt yalnızca güncellenmeli, asla ikinci bir kopya eklenmemeli.
        // payload aynı YANIT_ARIZA_KAYDI formatı (19 byte).
        const updated = this._parseArizaKaydiPayload(frame.payload);
        // Bu kod daha önce hiç görülmediyse, bu gerçekten YENİ bir arıza demektir —
        // anasayfadan otomatik Log'a atlamak için bu ayrımı en başta sabitliyoruz.
        const isNewFaultCode = !this._logRecords.some(r => r.code === updated.code);
        let existingIndex = this._logRecords.findIndex(
          r => r.code === updated.code && r.timestamp === updated.timestamp
        );
        if (existingIndex === -1) {
          // Tam zaman eşleşmesi yoksa (ör. saat senkron hatası/ufak sapma), aynı koda ait
          // en güncel oluşumu güncelle — bir kodun aynı anda tek "canlı" oluşumu olur,
          // bu da çift gönderim yüzünden yanlışlıkla ikinci bir kayıt eklenmesini önler.
          const sameCodeIndices = this._logRecords
            .map((r, i) => (r.code === updated.code ? i : -1))
            .filter(i => i !== -1);
          if (sameCodeIndices.length) {
            existingIndex = sameCodeIndices.reduce((best, i) =>
              this._logRecords[i].timestamp > this._logRecords[best].timestamp ? i : best
            );
          }
        }
        if (existingIndex >= 0) {
          this._logRecords[existingIndex] = updated;
        } else {
          this._logRecords.push(updated);
        }
        this.logsUI.render(this._logRecords);

        // Yeni bir aktif arıza geldi ve kullanıcı anasayfadaysa: hatayı direkt
        // görsün diye Log sayfasına otomatik atla (mevcut kayıtların durum
        // güncellemelerinde veya başka sayfalardayken yönlendirme yapılmaz).
        // Liste yukarıda zaten güncel veriyle render edildi, bu yüzden sayfa
        // değişince tam liste çekimini atlıyoruz (_skipNextLogsFetch).
        if (isNewFaultCode && updated.status === 'active' && this._currentPageIndex === 0) {
          this._skipNextLogsFetch = true;
          this.pager.goToPage(1);
        }
      } else if (frame.id === BleLink.STATUS_CANLI_IZLEME) {
        // Sadece en az bir istekli varken gelir (bkz. _wantLiveStream) — Canlı
        // İzle paneli açıkken ve/veya Self Tune aktifken.
        // payload (18 byte, 9 word LE, imzalı): I0,I1,I2,I3,I4,I5,I100,I101,I102
        const p = frame.payload;
        const word = (i) => (p[i] | (p[i + 1] << 8)) << 16 >> 16;
        const raw = {
          i0: word(0), i1: word(2), i2: word(4), i3: word(6), i4: word(8),
          i5: word(10), i100: word(12), i101: word(14), i102: word(16),
        };
        this.liveMonitorUI.update(raw);
        if (this._selfTuneActive) {
          this.selfTuneScreen.update(raw);
          this.selfTuneScreen.setStage(raw.i3);
          this._lastSelfTuneStageCode = raw.i3; // tamamlanma tespiti için (bkz. _handleSelfTuneCoilChange)
        }
      }
    } else if (frame.type === BleLink.TYPE_YANIT && frame.id === BleLink.YANIT_ENDA_BAGLANTI) {
      // payload: [sensör_tipi(1B), baud_rate(1B), modbus_adresi(1B)] — H28/H30/H48 register değerleri
      const [sensorTypeRaw, baudRateRaw, modbusAddr] = frame.payload;
      const sensorTypeLabel = this._applySensorType(sensorTypeRaw);
      const baudRateParam = HOLDING_BASE.find(p => p.addr === 0x001E);
      this.infoPopup.setConnectionInfo({
        modbusAddr,
        sensorType: sensorTypeLabel ?? `#${sensorTypeRaw}`,
        baudRate: baudRateParam?.options[baudRateRaw] ?? `#${baudRateRaw}`,
      });
    } else if (frame.type === BleLink.TYPE_YANIT && frame.id === BleLink.YANIT_PARAMETRE) {
      // payload: [reg_tipi(1B: 0=Holding 1=Coil), addr_low(1B), addr_high(1B), value_low(1B), value_high(1B)]
      const [regType, addrLow, addrHigh, valueLow, valueHigh] = frame.payload;
      const addr = addrLow | (addrHigh << 8);
      const isCoil = regType === 1;
      const value = isCoil ? valueLow : ((valueLow | (valueHigh << 8)) << 16 >> 16);
      this.settingsUI.applyParamValue(addr, isCoil, value);
      if (!isCoil && addr === 0x001C) this._applySensorType(value); // H28 — sensör tipi
      if (isCoil && addr === SELF_TUNE_COIL_ADDR) this._handleSelfTuneCoilChange(value); // C10

      this._receivedParamKeys.add(`${addr}|${isCoil}`);
      this.settingsOverlay.updateProgress(this._receivedParamKeys.size, EXPECTED_PARAM_KEYS.size);
    } else if (frame.type === BleLink.TYPE_YANIT && frame.id === BleLink.YANIT_PARAMETRE_BITTI) {
      // ESP "bitti" dedi — beklenen sayıya gerçekten ulaşıldı mı kontrol et.
      const missing = [...EXPECTED_PARAM_KEYS].filter(k => !this._receivedParamKeys.has(k));
      if (missing.length > 0) {
        this.settingsOverlay.showError(missing.length, missing);
      } else {
        this.settingsOverlay.showContent();
      }
    } else if (frame.type === BleLink.TYPE_YANIT && frame.id === BleLink.YANIT_PARAMETRE_YAZILDI) {
      // payload: [reg_tipi(1B), addr_low(1B), addr_high(1B), basarili(1B: 1=OK 0=hata)]
      const [regType, addrLow, addrHigh, success] = frame.payload;
      const addr = addrLow | (addrHigh << 8);
      const isCoil = regType === 1;
      if (!success) {
        console.warn('Parametre yazma başarısız:', { addr, isCoil });
      } else if (!isCoil && addr === 0x0024) {
        // Fabrika sıfırlama komutu (H36) onaylandı — ayarlar paneli açıksa tazele.
        if (this.settingsOverlay.overlay.classList.contains('show')) this._openSettingsPanel();
      } else {
        this.settingsUI.showWriteConfirmation(addr, isCoil);
      }
    } else if (frame.type === BleLink.TYPE_YANIT && frame.id === BleLink.YANIT_ARIZA_KAYIT_SAYISI) {
      // payload: [sayi_low(1B), sayi_high(1B)]
      const [countLow, countHigh] = frame.payload;
      this._expectedLogCount = countLow | (countHigh << 8);
      this.logsUI.updateProgress(0, this._expectedLogCount);
      if (this._expectedLogCount === 0) {
        this.logsUI.render([]);
      } else {
        this.ble.requestArizaKayitlari();
      }
    } else if (frame.type === BleLink.TYPE_YANIT && frame.id === BleLink.YANIT_ARIZA_KAYDI) {
      // payload (19 byte): [sira_low(1B), sira_high(1B), status(1B bit alanı),
      //   zaman_epoch(4B LE), giderilme_epoch(4B LE), kod(8B UTF-8)]
      // status bit alanı: bit0=AKTIF (1=koşul sürüyor), bit1=KALICI (1=kalıcı),
      // bit2=RESETLENMIS (sadece Kalıcı+giderildi'de anlamlı, diğerlerinde 0).
      // Geçmiş/Aktif ayrımı burada yapılmaz — ham alanlar LogsUI._isHistorical'a taşınır.
      this._logRecords.push(this._parseArizaKaydiPayload(frame.payload));
      this.logsUI.updateProgress(this._logRecords.length, this._expectedLogCount);
    } else if (frame.type === BleLink.TYPE_YANIT && frame.id === BleLink.YANIT_ARIZA_KAYITLARI_BITTI) {
      const missing = this._expectedLogCount - this._logRecords.length;
      if (missing > 0) {
        this.logsUI.showError(missing);
      } else {
        this.logsUI.render(this._logRecords);
      }
    } else if (frame.type === BleLink.TYPE_YANIT && frame.id === BleLink.YANIT_ARIZA_RESET) {
      // payload: [kod(8B UTF-8), basarili(1B: 1=OK 0=hata)]
      const p = frame.payload;
      const code = this._decodeFixedString(p, 0, 8);
      const success = p[8] === 1;
      if (success) {
        this._openLogsPanel(); // yerel yamalamak yerine ESP'den güncel listeyi tekrar iste
      } else {
        console.warn('Arıza resetleme başarısız:', code);
      }
    } else if (frame.type === BleLink.TYPE_YANIT && frame.id === BleLink.YANIT_ARIZA_GECMIS_SIL) {
      // payload: [basarili(1B: 1=OK 0=hata)]
      if (frame.payload[0] === 1) {
        this._openLogsPanel(); // geçmiş silindi, güncel listeyi tekrar iste
      } else {
        console.warn('Geçmiş kayıtlar silinemedi.');
      }
    } else if (frame.type === BleLink.TYPE_YANIT && frame.id === BleLink.YANIT_ARIZA_DETAY) {
      // payload: [kod(8B UTF-8)][açıklama metni — kalan tüm byte'lar, UTF-8]
      const p = frame.payload;
      const code = this._decodeFixedString(p, 0, 8);
      const description = new TextDecoder('utf-8').decode(new Uint8Array(p.slice(8)));
      this.logInfoModal.showDetail(code, description);
    } else if (frame.type === BleLink.TYPE_YANIT && frame.id === BleLink.YANIT_ARIZA_COZUM) {
      // payload: [kod(8B UTF-8)][çözüm listesi — kalan tüm byte'lar, UTF-8, satırlar "\n" ile ayrılır]
      const p = frame.payload;
      const code = this._decodeFixedString(p, 0, 8);
      const solutionText = new TextDecoder('utf-8').decode(new Uint8Array(p.slice(8)));
      this.logInfoModal.showSolution(code, solutionText);
    } else if (frame.type === BleLink.TYPE_YANIT && frame.id === BleLink.YANIT_YAZILIM_SURUMU) {
      // payload: sürüm metni, ham UTF-8 (ör. "1.2.0" — LEN alanı zaten uzunluğu taşır, sabit uzunluk yok)
      const version = new TextDecoder('utf-8').decode(new Uint8Array(frame.payload)).trim();
      this.firmwareUpdateUI.setCurrentVersion(version);
    } else if (frame.type === BleLink.TYPE_YANIT && frame.id === BleLink.YANIT_OTA_HAZIR) {
      // payload: [basarili(1B)][hata_kodu(1B, basarisizsa anlamlı — bkz. OTA_ERROR_MESSAGES)]
      this.firmwareUpdateUI.setOtaReady(frame.payload[0] === 1, frame.payload[1] || 0);
    } else if (frame.type === BleLink.TYPE_YANIT && frame.id === BleLink.YANIT_OTA_TAMAMLANDI) {
      // payload: [basarili(1B)][hata_kodu(1B, basarisizsa anlamlı — bkz. OTA_ERROR_MESSAGES)]
      this.firmwareUpdateUI.setOtaComplete(frame.payload[0] === 1, frame.payload[1] || 0);
    } else if (frame.type === BleLink.TYPE_YANIT && frame.id === BleLink.YANIT_OTA_PARCA_ALINDI) {
      // Bir grup bitince TEK sefer gelir. payload: [parca_no(2B LE, gruptaki
      // SON parçanın no'su)][basarili(1B)][hata_kodu(1B, basarisizsa anlamlı)]
      const chunkNo = frame.payload[0] | (frame.payload[1] << 8);
      this.firmwareUpdateUI.setOtaChunkAck(chunkNo, frame.payload[2] === 1, frame.payload[3] || 0);
    }
  }

  // Sabit uzunluklu, boş kalan kısmı 0x00 ile doldurulmuş bir UTF-8 alanı metne çevirir.
  _decodeFixedString(bytes, offset, length) {
    const slice = bytes.slice(offset, offset + length);
    const end = slice.indexOf(0);
    const trimmed = end === -1 ? slice : slice.slice(0, end);
    return new TextDecoder('utf-8').decode(new Uint8Array(trimmed)).trim();
  }

  // YANIT_ARIZA_KAYDI ve STATUS_ARIZA_DEGISTI aynı 19 byte'lık kayıt formatını
  // paylaşıyor — ham byte'ları { code, type, status, resetlendi, timestamp, clearedAt } yapısına çevirir.
  _parseArizaKaydiPayload(p) {
    const statusByte = p[2];
    const status = (statusByte & 0x01) ? 'active' : 'cleared';
    const type = (statusByte & 0x02) ? 'permanent' : 'temporary';
    const resetlendi = !!(statusByte & 0x04);
    const timestampEpoch = (p[3] | (p[4] << 8) | (p[5] << 16) | (p[6] << 24)) >>> 0;
    const clearedEpoch = (p[7] | (p[8] << 8) | (p[9] << 16) | (p[10] << 24)) >>> 0;
    const code = this._decodeFixedString(p, 11, 8);
    return {
      code, type, status, resetlendi,
      timestamp: timestampEpoch * 1000,
      clearedAt: clearedEpoch > 0 ? clearedEpoch * 1000 : null,
    };
  }

  // Bir Holding register'ın tanımını (range dahil) bulur — hem HOLDING_BASE'deki
  // sabit parametreler hem de profil adımlarının ürettiği H103..H134 register'ları
  // (bkz. getProfileStepRegs) için çalışır.
  _findHoldingDef(addr) {
    const base = HOLDING_BASE.find(p => p.addr === addr);
    if (base) return base;
    if (addr >= 0x0067 && addr <= 0x0086) {
      const stepIndex = Math.floor((addr - 0x0067) / 2) + 1;
      const regs = getProfileStepRegs(stepIndex);
      return addr === regs.target.addr ? regs.target : regs.time;
    }
    return null;
  }

  // Bir Holding değerinin (ekranda gösterilen, ölçeklenmiş metin hâli) izin
  // verilen aralıkta olup olmadığını kontrol eder — bkz. HOLDING_BASE'deki `range`
  // alanı ve resolveRangeBounds. Coil'ler zaten <select> ile sınırlı olduğundan
  // kontrol edilmez.
  _validateParamRange(addr, isCoil, displayValue) {
    if (isCoil) return { valid: true };
    const param = this._findHoldingDef(addr);
    if (!param?.range) return { valid: true };
    const num = parseFloat(displayValue);
    if (Number.isNaN(num)) return { valid: true }; // NaN zaten _writeParam'da ayrıca engelleniyor

    const bounds = resolveRangeBounds(param.range, this.settingsUI);
    if (num < bounds.min || num > bounds.max) {
      const fmt = (v) => (Number.isFinite(v) ? Number(v.toFixed(2)) : v);
      return {
        valid: false,
        message: `${param.tr}, ${fmt(bounds.min)} ile ${fmt(bounds.max)} arasında olmalıdır.`,
      };
    }
    return { valid: true };
  }

  // Bir parametre input/select'i değiştiğinde, önce izin verilen aralıkta mı diye
  // kontrol eder (aralık dışıysa uyarı gösterip son bilinen değere döner), sonra
  // ekrandaki (ölçeklenmiş) değeri Modbus'ın beklediği ham tam sayıya çevirip
  // ESP'ye yazma isteği gönderir.
  _writeParam(el) {
    const addr = Number(el.dataset.addr);
    const isCoil = el.dataset.coil === 'true';

    const validation = this._validateParamRange(addr, isCoil, el.value);
    if (!validation.valid) {
      this.alertModal.open('Geçersiz Değer', validation.message);
      const param = this._findHoldingDef(addr);
      el.value = this.settingsUI._cachedValue(addr, isCoil, param?.def ?? '');
      return;
    }

    let rawValue;
    if (isCoil) {
      rawValue = Number(el.value);
    } else {
      const param = HOLDING_BASE.find(p => p.addr === addr);
      if (param?.options) {
        rawValue = Number(el.value);
      } else {
        const decimals = this.settingsUI.getDecimalsFor(addr);
        rawValue = Math.round(parseFloat(el.value) * Math.pow(10, decimals));
      }
    }

    if (Number.isNaN(rawValue)) return;
    this.ble.writeParam(addr, isCoil, rawValue);

    // ESP onayını beklemeden değeri hemen önbelleğe/ekrana yansıt — böylece
    // profil adımı değiştirip geri dönünce (veya sekme kapanıp açılınca)
    // az önce yazılan değer, ESP'den yanıt gelmese bile ekranda kalır.
    this.settingsUI.applyParamValue(addr, isCoil, rawValue);
    if (isCoil && addr === SELF_TUNE_COIL_ADDR) this._handleSelfTuneCoilChange(rawValue); // C10
  }

  // H28 (Giriş/sensör tipi) ham değerini alır, "ondalıklı" mı değil mi anlar
  // (options listesindeki "ondalıklı" ifadesine bakarak) ve ölçek değiştiyse
  // ekranı doğru birimle göstermek için sıcaklık verisini tazeler.
  _applySensorType(rawIndex) {
    const sensorTypeParam = HOLDING_BASE.find(p => p.addr === 0x001C);
    const label = sensorTypeParam?.options[rawIndex];
    if (!label) return label;

    this.settingsUI._updateSensorTypeVisibility(rawIndex);

    const isDecimal = label.includes('ondalıklı');
    if (isDecimal !== this.tempHasDecimal) {
      this.tempHasDecimal = isDecimal;
      this.settingsUI.setTempDecimalMode(isDecimal);
      this.processScreen.setDecimalMode(isDecimal);
      this.liveMonitorUI.setDecimalMode(isDecimal);
      this.selfTuneScreen.setDecimalMode(isDecimal);
      if (this.ble.connected) this.ble.requestSicaklikSet(); // ölçek değişti, veriyi doğru birimle tazele
    }
    return label;
  }

  // Sıcaklık/set verisini ESP'ye sorar; yanıt gelmezse her saniye tekrar dener.
  // Gerçek veri gelince (_handleFrame'de) veya bağlantı kesilince durur.
  _requestSicaklikSetWithRetry() {
    this._stopSicaklikSetRetry();
    this.ble.requestSicaklikSet();
    this._sicaklikSetRetryTimer = setTimeout(
      () => this._requestSicaklikSetWithRetry(),
      WeldmacApp.SICAKLIK_SET_RETRY_INTERVAL_MS
    );
  }

  _stopSicaklikSetRetry() {
    if (this._sicaklikSetRetryTimer) {
      clearTimeout(this._sicaklikSetRetryTimer);
      this._sicaklikSetRetryTimer = null;
    }
  }

  // Adım/süre bilgisini ESP'ye sorar; yanıt gelmezse her saniye tekrar dener.
  // Gerçek veri gelince (_handleFrame'de) veya Proses fazından çıkılınca durur.
  _requestAdimDurumuWithRetry() {
    this._stopAdimDurumuRetry();
    this.ble.requestAdimDurumu();
    this._adimDurumuRetryTimer = setTimeout(
      () => this._requestAdimDurumuWithRetry(),
      WeldmacApp.ADIM_DURUMU_RETRY_INTERVAL_MS
    );
  }

  _stopAdimDurumuRetry() {
    if (this._adimDurumuRetryTimer) {
      clearTimeout(this._adimDurumuRetryTimer);
      this._adimDurumuRetryTimer = null;
    }
  }

  // Ayarlar dişlisine basılınca (veya "Tekrar Dene" ile) çağrılır: sayaç sıfırlanır,
  // "Parametreler Alınıyor" ekranı gösterilir ve ESP'den tüm parametreler istenir.
  _openSettingsPanel(endaIndex) {
    this._receivedParamKeys.clear();
    this.settingsOverlay.open(endaIndex);
    this.settingsOverlay.updateProgress(0, EXPECTED_PARAM_KEYS.size);
    this.ble.requestAllParams();
  }

  // Fabrika Ayarları onay modalından çağrılır — H36'ya (0x0024) ilgili magic değeri
  // yazar. Sonucu YANIT_PARAMETRE_YAZILDI ile gelir (bkz. _handleFrame), oradan
  // ayarlar paneli açıksa otomatik tazelenir.
  _sendFactoryReset(kind) {
    const code = FACTORY_RESET_CODES[kind];
    if (code === undefined) return;
    this.ble.writeParam(0x0024, false, code);
  }

  // Pager başka bir sayfaya geçince çağrılır — Arıza Kayıtları (index 1) ve Yazılım
  // Güncelleme (index 3) sayfalarına özel tetiklemeleri yapar, ayrıca hangi sayfada
  // olunduğunu izler (yeni bir arıza gelince anasayfadan otomatik yönlendirme için gerekli).
  _onPageChange(index) {
    this._currentPageIndex = index;
    if (index === 1) {
      if (this._skipNextLogsFetch) {
        // STATUS_ARIZA_DEGISTI push'u yüzünden otomatik yönlendirildik — liste zaten
        // güncel veriyle render edilmiş durumda, gereksiz yere tam liste çekip
        // kullanıcıya boşuna "Kayıtlar Alınıyor" ekranı göstermeyelim.
        this._skipNextLogsFetch = false;
      } else {
        this._openLogsPanel();
      }
    } else if (index === 3) {
      // Yazılım Güncelleme sayfasına her girişte sürüm kontrolü tazelenir —
      // kullanıcı "Tekrar Dene"ye basmak zorunda kalmadan güncel durumu görür.
      this.firmwareUpdateUI._checkVersions();
    }
  }

  // Arıza Kayıtları sayfasına her girildiğinde çağrılır: önce kaç kayıt olduğunu
  // sorar, cevap gelince (_handleFrame'de) kayıtların kendisi istenir.
  _openLogsPanel() {
    this._logRecords = [];
    this._expectedLogCount = null;
    this.logsUI.showLoading();
    this.logsUI.updateProgress(0, 0);
    this.ble.requestArizaKayitSayisi();
  }

  // BLE bağlantısı kesilince çağrılır: tüm önbelleklenmiş veriyi temizler, açık
  // overlay/pencereleri kapatır, anasayfaya döner ve pager/alt navigasyon yerine
  // Bağlantı Sayfası'nı gösterir (bkz. .ble-disconnected, style.css).
  _handleDisconnect() {
    this.lastTemps = [];
    this.currentPhase = 0;
    this._logRecords = [];
    this._expectedLogCount = null;
    this._receivedParamKeys.clear();

    this.processScreen.resetCurrentTemp();
    this._updateModeButtons();
    this.processScreen.showIdleOrPreheat(0, null);
    this.safetyIoUI.reset();
    this.logsUI.showLoading();
    this.logsUI.resetNavBadge();

    this.settingsOverlay.close();
    this.infoPopup.close();
    this.liveMonitorUI.close();
    this.paramInfoModal.close();
    this.logInfoModal.close();
    this.resetConfirmModal.close();
    this.fwUpdateConfirmModal.close();

    // Bağlantı koptuğunda ESP'nin canlı akış durumu bilinmez hale gelir —
    // yeniden bağlanınca C10'un gerçek değeri tazelendiğinde temiz başlasın diye
    // yerel takip sıfırlanır (bkz. _handleSelfTuneCoilChange, _wantLiveStream).
    // "Tamamlandı" onayı bekleniyor olsa bile bağlantı koptuğunda beklenmeden
    // hemen kapatılır.
    this._liveStreamWanters.clear();
    this._selfTuneActive = false;
    this._selfTuneStoppedByUser = false;
    this._lastSelfTuneStageCode = 0;
    this._selfTuneFinishing = false;
    this._stopSelfTunePidPoll();
    this.selfTuneScreen.reset();
    document.body.classList.remove('self-tune-mode');

    this.pager.goToPage(0);
    document.body.classList.add('ble-disconnected');
    this.connectionScreen.refresh();
  }

  // Ön Isıtma / Proses butonlarının çerçevesini günceller:
  // mod aktif ve hedef sıcaklığa ulaşılmamışsa "yılan" animasyonu,
  // mod aktif ve hedef sıcaklığa ulaşılmışsa sabit yeşil, aksi halde düz.
  // Ayrıca: BEKLEMEDE iken sadece Ön Isıtma/Proses butonları, bir mod aktifken
  // (Ön Isıtma ya da Proses) sadece Durdur butonu görünür.
  _updateModeButtons() {
    this.preheatBtn.classList.remove('mode-seeking', 'mode-reached');
    this.processBtn.classList.remove('mode-seeking', 'mode-reached');

    const modeActive = this.currentPhase === 1 || this.currentPhase === 2;
    this.startButtonsWrap.style.display = modeActive ? 'none' : 'flex';
    this.stopBtn.style.display = modeActive ? 'flex' : 'none';

    if (!modeActive) return;

    const reached = this.lastTemps.length > 0 &&
      this.lastTemps.every(t => Math.abs(t.current - t.target) <= WeldmacApp.TEMP_REACHED_TOLERANCE_C);

    const activeBtn = this.currentPhase === 1 ? this.preheatBtn : this.processBtn;
    activeBtn.classList.add(reached ? 'mode-reached' : 'mode-seeking');
  }

  // Proses fazındayken adım/hedef/kalan süre bilgisi ESP'den istenip gösterilir,
  // diğer fazlarda (BEKLEMEDE/ÖN ISITMA) bu bölüm yer tutucu/pasif hâle döner.
  _updateProcessSection() {
    if (this.currentPhase === 2) {
      this._requestAdimDurumuWithRetry();
    } else {
      this._stopAdimDurumuRetry();
      const currentTarget = this.lastTemps[0] ? this.lastTemps[0].target : null;
      this.processScreen.showIdleOrPreheat(this.currentPhase, currentTarget);
    }
  }

  // ESP bağlı değilken tarayıcı konsolundan çağırmak için test yardımcıları
  _exposeTestHelpers() {
    window.testTemps = (temps) => {
      this.lastTemps = temps;
      if (temps[0]) {
        this.processScreen.updateCurrentTemp(temps[0].current);
        if (this.currentPhase !== 2) this.processScreen.updateIdleTarget(temps[0].target);
      }
      this._updateModeButtons();
    };
    window.testPhase = (fazKodu) => {
      this.currentPhase = fazKodu;
      this._updateModeButtons();
      this._updateProcessSection();
    };
    // örnek: testAdimDurumu(1, 2, 754, 160.0, 5) -> Adım 1/2, kalan 12:34, hedef 160.0°C ±5
    // configuredDuration verirsen (ör. testAdimDurumu(2, 2, 0, 200, 5, 90)) yeni adıma
    // geçişte sayaç, ESP'nin kalan_süre'sini değil bu değeri (90) kullanarak başlar.
    window.testAdimDurumu = (stepNo, totalSteps, remainingSeconds, targetTemp, tolerance, configuredDuration = null) =>
      this.processScreen.updateStep({ stepNo, totalSteps, remainingSeconds, targetTemp, tolerance, configuredDuration });
    // örnek: testGirisler({ faz1:1, faz2:1, faz3:0, fazKoruma:1, termik:1, softStarter:1, basinc:0, selenoidYukari:1, selenoidAsagi:0, chiller:1 })
    window.testGirisler = (states) => this.safetyIoUI.update(states);
    // örnek: testLogs([
    //   { code:'E101', type:'temporary', status:'cleared', resetlendi:false, timestamp:'2026-07-08T14:32:05', clearedAt:'2026-07-08T14:35:10' },
    //   { code:'E103', type:'permanent', status:'active', resetlendi:false, timestamp:'2026-07-11T09:00:00', clearedAt:null },
    //   { code:'E205', type:'permanent', status:'cleared', resetlendi:false, timestamp:'2026-07-11T08:00:00', clearedAt:'2026-07-11T08:05:00' },
    //   { code:'E202', type:'permanent', status:'cleared', resetlendi:true,  timestamp:'2026-07-10T08:00:00', clearedAt:'2026-07-10T08:05:00' },
    // ])
    // -> E101 (geçici+giderildi) Geçmiş'te, sarı çerçeve, rozet/buton yok;
    //    E103 (kalıcı+aktif) Aktif'te, kırmızı çerçeve, "Devam Ediyor" yazısı, Resetle YOK (koşul sürüyor);
    //    E205 (kalıcı+giderildi AMA resetlenmedi) YİNE Aktif'te kalır, "Giderildi" yazısı + Resetle VAR;
    //    E202 (kalıcı+giderildi+resetlendi) ancak bu üçü birlikteyken Geçmiş'e düşer, yazı/buton yok
    window.testLogs = (records) => this.logsUI.render(records);
    // örnek: testArizaReset('E103', true) -> ESP onayını simüle eder (Resetle butonuna basılınca gerçekte tetiklenen akış)
    window.testArizaReset = (code, success) => this._handleFrame({
      type: BleLink.TYPE_YANIT, id: BleLink.YANIT_ARIZA_RESET,
      payload: [...this.ble._encodeFixedString(code, 8), success ? 1 : 0],
    });
    // örnek: testArizaGecmisSil(true) -> "Tüm Geçmişi Sil" onayını simüle eder (sonrasında liste otomatik tekrar istenir)
    window.testArizaGecmisSil = (success) => this._handleFrame({
      type: BleLink.TYPE_YANIT, id: BleLink.YANIT_ARIZA_GECMIS_SIL,
      payload: [success ? 1 : 0],
    });
    // örnek: testArizaGuncelleme('E406', { aktif:false, kalici:true, resetlendi:false }, '2026-07-11T10:00:00', '2026-07-11T10:05:00')
    // -> Log sayfası açıkken ESP'nin STATUS_ARIZA_DEGISTI push'unu simüle eder (liste anında güncellenir)
    window.testArizaGuncelleme = (code, flags, timestamp, clearedAt) => {
      const statusByte = (flags.aktif ? 0x01 : 0) | (flags.kalici ? 0x02 : 0) | (flags.resetlendi ? 0x04 : 0);
      const ts = Math.floor(new Date(timestamp).getTime() / 1000);
      const clearedTs = clearedAt ? Math.floor(new Date(clearedAt).getTime() / 1000) : 0;
      const toBytes4 = n => [n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >> 24) & 0xFF];
      this._handleFrame({
        type: BleLink.TYPE_DURUM, id: BleLink.STATUS_ARIZA_DEGISTI,
        payload: [0, 0, statusByte, ...toBytes4(ts), ...toBytes4(clearedTs), ...this.ble._encodeFixedString(code, 8)],
      });
    };
    // örnek: testArizaDetay('E101', 'ENDA kartından Modbus yanıtı alınamadı.') -> bloğa tıklayınca ESP'nin göndereceği akışı simüle eder
    window.testArizaDetay = (code, description) => this._handleFrame({
      type: BleLink.TYPE_YANIT, id: BleLink.YANIT_ARIZA_DETAY,
      payload: [...this.ble._encodeFixedString(code, 8), ...new TextEncoder().encode(description)],
    });
    // örnek: testArizaCozum('E101', 'RS485 A/B hattını kontrol et\nModbus adresini kontrol et') -> "Nasıl Çözerim?" akışını simüle eder
    window.testArizaCozum = (code, solutionText) => this._handleFrame({
      type: BleLink.TYPE_YANIT, id: BleLink.YANIT_ARIZA_COZUM,
      payload: [...this.ble._encodeFixedString(code, 8), ...new TextEncoder().encode(solutionText)],
    });
    window.testLogsLoading = () => this.logsUI.showLoading();
    // örnek: testLogsProgress(12, 123)
    window.testLogsProgress = (received, total) => this.logsUI.updateProgress(received, total);
    // örnek: testLogsError(5) -> "5 kayıt alınamadı"
    window.testLogsError = (missingCount) => this.logsUI.showError(missingCount);
    // örnek: testFirmwareVersion('1.2.0')
    window.testFirmwareVersion = (version) => this.firmwareUpdateUI.setCurrentVersion(version);
    // Güncelle butonuna basılınca gerçek indirme+gönderme akışı çalışır; ESP henüz
    // hazır değilse bu ikisiyle YANIT_OTA_HAZIR / YANIT_OTA_TAMAMLANDI'yi simüle et:
    // örnek: testOtaHazir(true) veya hata: testOtaHazir(false, 0x01)
    window.testOtaHazir = (success, errorCode = 0) => this.firmwareUpdateUI.setOtaReady(success, errorCode);
    // örnek: testOtaTamamlandi(true) veya hata: testOtaTamamlandi(false, 0x06)
    window.testOtaTamamlandi = (success, errorCode = 0) => this.firmwareUpdateUI.setOtaComplete(success, errorCode);
    // örnek: testOtaParcaAlindi(63, true) (ilk grup 0..63 için) veya hata: testOtaParcaAlindi(63, false, 0x05)
    window.testOtaParcaAlindi = (lastChunkNo, success = true, errorCode = 0) => this.firmwareUpdateUI.setOtaChunkAck(lastChunkNo, success, errorCode);
    // örnek: testEndaBaglanti({ modbusAddr: 1, sensorType: 'PT100', baudRate: '9600 bps' })
    window.testEndaBaglanti = (connInfo) => this.infoPopup.setConnectionInfo(connInfo);
    // örnek: testParam(0x0000, false, 450) -> H0'ı 450 yapar; testParam(0x0004, true, 1) -> C4'ü Açık yapar
    window.testParam = (addr, isCoil, value) => this.settingsUI.applyParamValue(addr, isCoil, value);
    // parametreler geldi sinyalini simüle eder — yükleniyor ekranından çıkar
    window.testParamsDone = () => this.settingsOverlay.showContent();
    // örnek: testSensorType(3) -> 'J' (ondalıksız); testSensorType(2) -> 'J ondalıklı'
    window.testSensorType = (rawIndex) => this._applySensorType(rawIndex);
    // örnek: testWriteConfirm(0x0000, false, true) -> H0 satırında ✓ gösterir
    window.testWriteConfirm = (addr, isCoil, success = true) =>
      this._handleFrame({ type: BleLink.TYPE_YANIT, id: BleLink.YANIT_PARAMETRE_YAZILDI, payload: [isCoil ? 1 : 0, addr & 0xFF, (addr >> 8) & 0xFF, success ? 1 : 0] });
  }
}

// =====================================================================
// INIT
// =====================================================================
new WeldmacApp();
