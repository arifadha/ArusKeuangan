// ============================================================
// KONSTANTA
// ============================================================
const SS_ID        = '1MJqaqJrzGqCFtdhJJ0wDzUf4JRC-_CUQzCGaFQRZm-8';
const FOLDER_ID    = '1oSiJs21JryBEqBnl5jx-u41YPABc5gD9';
const SH_USERS     = 'Users';
const SH_SESSIONS  = 'Sessions';
const SH_TRANSAKSI = 'Transaksi';
const SH_REF       = 'Referensi';
const SH_LOG       = 'Log';

// ============================================================
// UTILITY
// ============================================================
const ss_     = () => SpreadsheetApp.openById(SS_ID);
const sheet_  = n  => ss_().getSheetByName(n);
const tz_     = () => Session.getScriptTimeZone();
const nowStr_ = () => Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm:ss');

function hashPassword_(pw) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, pw, Utilities.Charset.UTF_8);
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function getNextId_(sheetName) {
  const sh = sheet_(sheetName);
  const last = sh.getLastRow();
  if (last < 2) return 1;
  return Number(sh.getRange(last, 1).getValue()) + 1;
}

// ============================================================
// SETUP — jalankan sekali untuk inisialisasi semua sheet
// ============================================================
function setupSheets() {
  const wb = ss_();
  const schemas = {
    [SH_USERS]:     ['ID','Username','Password','Nama','Role','Aktif','CreatedAt'],
    [SH_SESSIONS]:  ['Token','UserID','Username','Role','DeviceInfo','LoginAt','ExpiredAt'],
    [SH_TRANSAKSI]: ['ID','Tanggal','Jenis','Kategori','Jumlah','Metode','Bank','Deskripsi','FileUrl','UserID','CreatedAt'],
    [SH_REF]:       ['Jenis','Kategori','Metode','Bank'],
    [SH_LOG]:       ['Waktu','UserID','Username','Aksi','Detail'],
  };
  Object.entries(schemas).forEach(([name, headers]) => {
    let sh = wb.getSheetByName(name);
    if (!sh) sh = wb.insertSheet(name);
    else sh.clearContents();
    sh.getRange(1,1,1,headers.length).setValues([headers]);
    sh.getRange(1,1,1,headers.length).setBackground('#1e293b').setFontColor('#ffffff').setFontWeight('bold');
  });
  // Seed admin
  sheet_(SH_USERS).appendRow([1,'admin',hashPassword_('admin123'),'Administrator','admin',true,nowStr_()]);
  // Seed referensi
  const refData = [
    ['Pemasukan','Gaji','Transfer','BCA'],['Pemasukan','Bonus','Cash','BRI'],
    ['Pemasukan','Freelance','QRIS','BNI'],['Pemasukan','Investasi','Debit','Mandiri'],
    ['Pengeluaran','Makan','Kredit','BSI'],['Pengeluaran','Transport','','GoPay'],
    ['Pengeluaran','Belanja','','OVO'],['Pengeluaran','Tagihan','','Dana'],
    ['Pengeluaran','Hiburan','',''],['Pengeluaran','Kesehatan','',''],
  ];
  refData.forEach(r => sheet_(SH_REF).appendRow(r));
  return { success: true, message: 'Setup selesai! Login: admin / admin123' };
}

// ============================================================
// ENTRY POINT
// ============================================================
function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('💰 Keuangan App')
    .addMetaTag('viewport','width=device-width,initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
function include(f) { return HtmlService.createHtmlOutputFromFile(f).getContent(); }

// ============================================================
// AUTH
// ============================================================
function login(username, password, deviceInfo) {
  const sh = sheet_(SH_USERS);
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    const [id, uname, hash, nama, role, aktif] = rows[i];
    if (uname !== username) continue;
    if (!aktif) return { success: false, message: 'Akun tidak aktif.' };
    if (hash !== hashPassword_(password)) return { success: false, message: 'Password salah.' };
    invalidateUserSessions_(id);
    const tok = Utilities.getUuid();
    const now = new Date();
    const exp = new Date(now.getTime() + 8*60*60*1000);
    sheet_(SH_SESSIONS).appendRow([
      tok, id, uname, role, deviceInfo||'unknown',
      Utilities.formatDate(now, tz_(),'yyyy-MM-dd HH:mm:ss'),
      Utilities.formatDate(exp, tz_(),'yyyy-MM-dd HH:mm:ss')
    ]);
    addLog_(id, uname, 'LOGIN', deviceInfo);
    return { success: true, token: tok, user: { id, username: uname, nama, role } };
  }
  return { success: false, message: 'Username tidak ditemukan.' };
}

function logout(token) {
  deleteSession_(token);
  return { success: true };
}

function validateSession(token) {
  if (!token) return null;
  const sh = sheet_(SH_SESSIONS);
  const rows = sh.getDataRange().getValues();
  const now = new Date();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] !== token) continue;
    // Toleran terhadap berbagai format tanggal expired
    try {
      const exp = new Date(rows[i][6]);
      if (isNaN(exp.getTime()) || now > exp) { sh.deleteRow(i+1); return null; }
    } catch(e) { sh.deleteRow(i+1); return null; }
    return { id: rows[i][1], username: rows[i][2], role: rows[i][3] };
  }
  return null;
}

function invalidateUserSessions_(userId) {
  const sh = sheet_(SH_SESSIONS);
  const rows = sh.getDataRange().getValues();
  for (let i = rows.length-1; i >= 1; i--)
    if (rows[i][1] == userId) sh.deleteRow(i+1);
}

function deleteSession_(token) {
  const sh = sheet_(SH_SESSIONS);
  const rows = sh.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++)
    if (rows[i][0] === token) { sh.deleteRow(i+1); return; }
}

// ============================================================
// REFERENSI
// ============================================================
function getReferensi() {
  const rows = sheet_(SH_REF).getDataRange().getValues();
  rows.shift();
  const kategoriPerJenis = {};
  const metode = [...new Set(rows.map(r=>r[2]).filter(Boolean))];
  const bank   = [...new Set(rows.map(r=>r[3]).filter(Boolean))];
  rows.forEach(([jenis,kategori]) => {
    if (!jenis||!kategori) return;
    if (!kategoriPerJenis[jenis]) kategoriPerJenis[jenis]=[];
    if (!kategoriPerJenis[jenis].includes(kategori)) kategoriPerJenis[jenis].push(kategori);
  });
  return { kategoriPerJenis, metode, bank };
}

// ============================================================
// TRANSAKSI
// ============================================================
function getTransaksi(token) {
  const user = validateSession(token);
  if (!user) return { error:'SESSION_EXPIRED' };
  const rows = sheet_(SH_TRANSAKSI).getDataRange().getValues();
  if (rows.length < 2) return [];
  rows.shift();
  return rows.map(r => ({
    id:r[0]||'', tanggal:r[1]?Utilities.formatDate(new Date(r[1]),tz_(),'yyyy-MM-dd'):'',
    jenis:r[2]||'', kategori:r[3]||'', jumlah:r[4]||0, metode:r[5]||'',
    bank:r[6]||'', deskripsi:r[7]||'', file:r[8]||'', userId:r[9]||'', createdAt:r[10]||''
  }));
}

function tambahTransaksi(data, token) {
  const user = validateSession(token);
  if (!user) return { error:'SESSION_EXPIRED' };
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const id = getNextId_(SH_TRANSAKSI);
    sheet_(SH_TRANSAKSI).appendRow([
      id, data.tanggal, data.jenis, data.kategori, Number(data.jumlah),
      data.metode||'', data.bank||'', data.deskripsi||'', data.fileUrl||'', user.id, nowStr_()
    ]);
    addLog_(user.id, user.username, 'TAMBAH_TRX', `#${id} ${data.jenis} ${data.jumlah}`);
    return { success:true, message:`Transaksi #${id} berhasil disimpan` };
  } finally { lock.releaseLock(); }
}

function updateTransaksi(data, token) {
  const user = validateSession(token);
  if (!user) return { error:'SESSION_EXPIRED' };
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const sh = sheet_(SH_TRANSAKSI);
    const rows = sh.getDataRange().getValues();
    for (let i=1; i<rows.length; i++) {
      if (rows[i][0] != data.id) continue;
      const oldFile = rows[i][8]||'';
      if (data.fileUrl && data.fileUrl!==oldFile && oldFile) {
        try { const m=oldFile.match(/[-\w]{25,}/); if(m) DriveApp.getFileById(m[0]).setTrashed(true); } catch(e){}
      }
      sh.getRange(i+1,2,1,9).setValues([[
        data.tanggal, data.jenis, data.kategori, Number(data.jumlah),
        data.metode||'', data.bank||'', data.deskripsi||'',
        data.fileUrl||oldFile, rows[i][9]
      ]]);
      addLog_(user.id, user.username, 'UPDATE_TRX', `#${data.id}`);
      return { success:true, message:`Transaksi #${data.id} diperbarui` };
    }
    return { success:false, message:'Data tidak ditemukan' };
  } finally { lock.releaseLock(); }
}

function hapusTransaksi(id, token) {
  const user = validateSession(token);
  if (!user) return { error:'SESSION_EXPIRED' };
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const sh = sheet_(SH_TRANSAKSI);
    const rows = sh.getDataRange().getValues();
    for (let i=1; i<rows.length; i++) {
      if (rows[i][0] != id) continue;
      try { const m=(rows[i][8]||'').match(/[-\w]{25,}/); if(m) DriveApp.getFileById(m[0]).setTrashed(true); } catch(e){}
      sh.deleteRow(i+1);
      addLog_(user.id, user.username, 'HAPUS_TRX', `#${id}`);
      return { success:true, message:`Transaksi #${id} dihapus` };
    }
    return { success:false, message:'Data tidak ditemukan' };
  } finally { lock.releaseLock(); }
}

// ============================================================
// USER MANAGEMENT (admin only)
// ============================================================
function getUsers(token) {
  const user = validateSession(token);
  if (!user) return { error:'SESSION_EXPIRED' };
  if (user.role!=='admin') return { error:'FORBIDDEN' };
  const rows = sheet_(SH_USERS).getDataRange().getValues();
  rows.shift();
  return rows.map(r=>({ id:r[0],username:r[1],nama:r[3],role:r[4],aktif:r[5],createdAt:r[6] }));
}

function tambahUser(data, token) {
  const user = validateSession(token);
  if (!user) return { error:'SESSION_EXPIRED' };
  if (user.role!=='admin') return { error:'FORBIDDEN' };
  const rows = sheet_(SH_USERS).getDataRange().getValues();
  if (rows.slice(1).some(r=>r[1]===data.username)) return { success:false, message:'Username sudah ada.' };
  const id = getNextId_(SH_USERS);
  sheet_(SH_USERS).appendRow([id,data.username,hashPassword_(data.password),data.nama,data.role||'user',true,nowStr_()]);
  addLog_(user.id, user.username, 'TAMBAH_USER', data.username);
  return { success:true, message:`User ${data.username} ditambahkan` };
}

function updateUser(data, token) {
  const user = validateSession(token);
  if (!user) return { error:'SESSION_EXPIRED' };
  if (user.role!=='admin') return { error:'FORBIDDEN' };
  const sh = sheet_(SH_USERS);
  const rows = sh.getDataRange().getValues();
  for (let i=1; i<rows.length; i++) {
    if (rows[i][0] != data.id) continue;
    sh.getRange(i+1,4).setValue(data.nama);
    sh.getRange(i+1,5).setValue(data.role);
    sh.getRange(i+1,6).setValue(data.aktif);
    if (data.password) sh.getRange(i+1,3).setValue(hashPassword_(data.password));
    addLog_(user.id, user.username, 'UPDATE_USER', `ID:${data.id}`);
    return { success:true, message:'User diperbarui' };
  }
  return { success:false, message:'User tidak ditemukan' };
}

function hapusUser(id, token) {
  const user = validateSession(token);
  if (!user) return { error:'SESSION_EXPIRED' };
  if (user.role!=='admin') return { error:'FORBIDDEN' };
  if (id==user.id) return { success:false, message:'Tidak bisa hapus akun sendiri.' };
  const sh = sheet_(SH_USERS);
  const rows = sh.getDataRange().getValues();
  for (let i=1; i<rows.length; i++) {
    if (rows[i][0] != id) continue;
    sh.deleteRow(i+1);
    invalidateUserSessions_(id);
    addLog_(user.id, user.username, 'HAPUS_USER', `ID:${id}`);
    return { success:true, message:'User dihapus' };
  }
  return { success:false, message:'User tidak ditemukan' };
}

// ============================================================
// REFERENSI MANAGEMENT (admin)
// ============================================================
function getKategori(token) {
  const user = validateSession(token);
  if (!user) return { error:'SESSION_EXPIRED' };
  const rows = sheet_(SH_REF).getDataRange().getValues();
  rows.shift();
  return rows.map((r,i)=>({ row:i+2,jenis:r[0],kategori:r[1],metode:r[2],bank:r[3] }))
    .filter(r=>r.jenis||r.kategori||r.metode||r.bank);
}

function tambahKategori(data, token) {
  const user = validateSession(token);
  if (!user) return { error:'SESSION_EXPIRED' };
  if (user.role!=='admin') return { error:'FORBIDDEN' };
  sheet_(SH_REF).appendRow([data.jenis||'',data.kategori||'',data.metode||'',data.bank||'']);
  return { success:true, message:'Referensi ditambahkan' };
}

function hapusKategori(rowNum, token) {
  const user = validateSession(token);
  if (!user) return { error:'SESSION_EXPIRED' };
  if (user.role!=='admin') return { error:'FORBIDDEN' };
  sheet_(SH_REF).deleteRow(rowNum);
  return { success:true, message:'Referensi dihapus' };
}

// ============================================================
// UPLOAD FILE
// ============================================================
function uploadFileToDrive(formObject, token) {
  const user = validateSession(token);
  if (!user) return { error:'SESSION_EXPIRED' };
  try {
    const blob = Utilities.newBlob(Utilities.base64Decode(formObject.content),formObject.type,formObject.name);
    if (!/\.(jpg|jpeg|png|pdf|doc|docx|xls|xlsx|zip|rar)$/i.test(formObject.name)) throw new Error('Tipe file tidak diizinkan.');
    if (blob.getBytes().length > 10*1024*1024) throw new Error('File terlalu besar (maks 10MB).');
    const file = DriveApp.getFolderById(FOLDER_ID).createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return { success:true, url:file.getUrl(), name:file.getName() };
  } catch(e) { return { success:false, message:e.message }; }
}

// ============================================================
// LOG
// ============================================================
function addLog_(userId, username, aksi, detail) {
  try { sheet_(SH_LOG).appendRow([nowStr_(),userId,username,aksi,detail||'']); } catch(e){}
}
function getLogs(token) {
  const user = validateSession(token);
  if (!user||user.role!=='admin') return { error:'FORBIDDEN' };
  const rows = sheet_(SH_LOG).getDataRange().getValues();
  rows.shift();
  return rows.reverse().slice(0,100).map(r=>({ waktu:r[0],username:r[2],aksi:r[3],detail:r[4] }));
}

// ============================================================
// DEBUG — jalankan dari Apps Script editor untuk cek status
// ============================================================
function debugStatus() {
  const wb = ss_();
  const result = {};
  ['Users','Sessions','Transaksi','Referensi','Log'].forEach(name => {
    const sh = wb.getSheetByName(name);
    result[name] = sh ? sh.getLastRow() - 1 + ' rows' : 'SHEET NOT FOUND';
  });
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}
