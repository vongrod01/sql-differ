'use strict';

// Thai is the source language. Only developer-authored string/template parts are translated;
// interpolated database names, server names, SQL, logs and errors are left intact.
(() => {
  const KEY = 'database-diff.language';
  const EN = {
    'ภาษา': 'Language',
    'เปรียบเทียบ': 'Compare',
    'ประวัติ': 'History',
    'ตั้งเวลา': 'Schedules',
    'หายไป': 'Removed',
    'เคยมีในจุด': 'Existed at',
    'จาก': 'From',
    'แต่จุด': 'but at',
    'ถึง': 'To',
    'ไม่มีแล้ว': 'it no longer exists',
    'เพิ่มขึ้นมา': 'Added',
    'จุด': 'At',
    'ยังไม่มี เพิ่งมีในจุด': 'it did not exist; first appeared at',
    'ถูกแก้': 'Changed',
    'มีทั้งสองจุด แต่ไม่เหมือนเดิม': 'Exists at both points, with changes',
    'ตรวจไม่ได้': 'Unverified',
    'อ่านค่าไม่ได้ (ไม่มีสิทธิ์ หรือถูกเข้ารหัส) จึงบอกไม่ได้ว่าเปลี่ยนหรือไม่': 'Cannot read the value (permission denied or encrypted), so changes cannot be verified',
    'เหมือนเดิม': 'Unchanged',
    'ต้องเพิ่ม': 'To add',
    'ต้นแบบมี แต่ปลายทางยังไม่มี sync จะสร้างให้ ยกเว้นส่วนที่ไฟล์ sync เขียนไว้เป็นหมายเหตุให้ทำเอง': 'Exists in the source only. Sync creates it, except for operations marked as manual steps in the script',
    'มีเกิน': 'Extra',
    'ปลายทางมีแต่ต้นแบบไม่มี sync ไม่ลบให้ แค่เขียนคำสั่งลบไว้เป็นหมายเหตุ': 'Exists in the target only. Sync includes a commented removal command',
    'ต้องแก้': 'To change',
    'มีทั้งคู่แต่ไม่เหมือนกัน sync จะแก้ปลายทางให้ตรงต้นแบบ ยกเว้นส่วนที่ไฟล์ sync เขียนไว้เป็นหมายเหตุให้ทำเอง': 'Exists on both sides with differences. Sync updates the target to match the source, except for manual steps',
    'อ่านค่าไม่ได้ (ไม่มีสิทธิ์ หรือถูกเข้ารหัส) จึงเทียบไม่ได้ และไม่เขียนคำสั่งให้': 'Cannot read the value (permission denied or encrypted). No comparison or script is available',
    'ตรงกัน': 'Identical',
    'ผลไม่ครบ': 'Incomplete',
    'เทียบไม่สำเร็จ': 'Comparison failed',
    'ฐาน': 'databases',
    'กำลังรัน': 'Running',
    'เสร็จ': 'Done',
    'ล้มเหลว': 'Failed',
    'รายการ ใช้พื้นที่': 'runs, using',
    '· ไม่ลบอัตโนมัติ เพราะค่า DATABASE_DIFF_RETENTION_DAYS': '· Automatic cleanup disabled: DATABASE_DIFF_RETENTION_DAYS',
    'ไม่ใช่จำนวนวัน': 'is not a valid number of days',
    '· ไม่ลบอัตโนมัติ (DATABASE_DIFF_RETENTION_DAYS=0)': '· Automatic cleanup disabled (DATABASE_DIFF_RETENTION_DAYS=0)',
    '· ลบอัตโนมัติเมื่อเก่ากว่า': '· Automatically delete runs older than',
    'วัน นับถอยจากการรันครั้งล่าสุด แต่เก็บ': 'days before the newest run; always keep the latest',
    'รายการล่าสุดไว้เสมอ': 'runs',
    'ฐานเดียว': 'Single database',
    'หลายฐาน': 'Multiple databases',
    'ทุกฐานที่ชื่อตรงกัน': 'All matching databases',
    'กดอีกครั้งเพื่อยืนยัน': 'Click again to confirm',
    'หมวดที่เปรียบเทียบ': 'Categories to compare',
    'หลัก': 'Main',
    'เพิ่มเติม': 'Additional',
    'ค่าเริ่มต้น (5 หมวดหลัก)': 'Default (5 main categories)',
    'ทั้งหมด': 'All',
    'เลือกหมวดที่จะเปรียบเทียบอย่างน้อย 1 หมวด': 'Select at least one category to compare',
    'ไม่สนช่องว่าง (whitespace)': 'Ignore whitespace',
    'ไม่สนตัวพิมพ์เล็ก/ใหญ่': 'Ignore case',
    'ไม่เทียบ collation': 'Ignore collation',
    'เทียบลำดับคอลัมน์ด้วย': 'Compare column order',
    'ไม่พบ server:': 'Server not found:',
    'กำลังโหลด...': 'Loading...',
    'รูปแบบ': 'Comparison mode',
    'หลายฐาน (batch)': 'Multiple databases (batch)',
    'ฐานที่จะเทียบ': 'Databases to compare',
    'ทุกฐานที่ชื่อตรงกันทั้งสองฝั่ง (รวมฐานที่จะเพิ่มทีหลังด้วย)': 'All databases with matching names on both sides (including databases added later)',
    'เลือกเอง': 'Choose manually',
    'เลือกทั้งหมด': 'Select all',
    'ไม่เลือกเลย': 'Clear selection',
    'ตัวเลือก': 'Options',
    'ต้นแบบ: ตัวที่ถูกต้อง (source)': 'Source: the reference schema',
    'ปลายทาง: ตัวที่จะถูกปรับ (target)': 'Target: the schema to update',
    'โหลดรายชื่อฐานฝั่ง': 'Cannot load databases for',
    'ไม่ได้ ดูรายละเอียดใต้ช่อง Server': 'See the details below the Server field',
    'ไม่มีฐานที่ชื่อตรงกันทั้งสองฝั่ง': 'No databases with matching names on both sides',
    '(เข้าไม่ได้ฝั่ง': '(Access denied on',
    'เลือก server ก่อน': 'Select a server first',
    'ไม่พบ server เดิมแล้ว เลือก server ใหม่': 'The previous server no longer exists. Select another server',
    '-- เลือก database --': '-- Select a database --',
    '(เข้าไม่ได้)': '(Access denied)',
    '(ไม่มีสิทธิ์ VIEW DEFINITION)': '(No VIEW DEFINITION permission)',
    'login นี้เข้าได้': 'This login can access',
    'ฐาน (ฐานที่เข้าไม่ได้แสดงไว้แต่เลือกไม่ได้)': 'databases (inaccessible databases are listed but disabled)',
    'ไม่มีสิทธิ์ VIEW DEFINITION ใน': 'Missing VIEW DEFINITION permission in',
    'ฐานที่เข้าได้ ผลเทียบของฐานเหล่านั้นจะไม่ครบ': 'accessible databases; their comparison results will be incomplete',
    'โหลดไม่ได้': 'Unable to load',
    'เลือก server ทั้งสองฝั่งก่อน': 'Select a server on both sides first',
    'เลือกฐานอย่างน้อย 1 ฐาน': 'Select at least one database',
    'เลือก database ทั้งสองฝั่งก่อน': 'Select a database on both sides first',
    'เปรียบเทียบ schema': 'Compare schemas',
    'อ่านอย่างเดียว ไม่แก้ไขฐานข้อมูลใดๆ': 'Read-only. No databases will be modified',
    'เริ่มเปรียบเทียบ': 'Start comparison',
    'รีเซต': 'Reset',
    'ระบบจำตัวเลือกไว้ให้จนกว่าจะกดรีเซต': 'Your choices are saved until you press Reset',
    'ระบบไม่รัน script ให้ ต้อง review แล้วรันเองใน SSMS': 'Review and run the script yourself in SSMS.',
    'script เริ่มด้วย USE ของฐานปลายทาง ถ้าเข้าฐานนั้นไม่ได้จะไม่รันคำสั่งใดเลย': 'The script starts with USE for the target database. It stops if that database is inaccessible.',
    'index, constraint และ default ที่เปลี่ยนจะถูกแทนที่ใน transaction เดียว ส่วนคำสั่ง DROP ถูก comment ไว้ท้ายไฟล์': 'Changed indexes, constraints and defaults are replaced in one transaction. DROP commands are commented out at the end of the file',
    'Script ย้อนกลับ': 'Revert script',
    'รันบนฝั่ง': 'Run on',
    'เพื่อให้ schema กลับไปเป็นแบบ': 'to restore the schema from',
    'รันบน target เพื่อให้ schema ตรงกับ source': 'Run on the target to match the source schema.',
    'รันบน target หลังรัน sync script เพื่อย้อน schema กลับเป็นแบบตอนเปรียบเทียบ': 'Run on the target after syncing to restore the schema as it was at comparison time.',
    '(ใช้ได้เมื่อหลังเปรียบเทียบ target ถูกแก้โดย sync script เท่านั้น) ของที่ sync script สร้างจะถูก DROP': '(Valid only if the sync script made all changes since comparison.) Objects created by sync will be dropped,',
    'ยกเว้น table และ column ที่ถูก comment ไว้ท้ายไฟล์ เพราะลบแล้วข้อมูลหาย': 'except tables and columns: their DROP commands are commented out because deletion loses data',
    'ถ้าฝั่งที่ไม่มีสิทธิ์ VIEW DEFINITION คือ target: object ที่มีแค่ใน source จะถูกเขียนเป็น CREATE ธรรมดา': 'If the target lacks VIEW DEFINITION permission, source-only objects use plain CREATE commands',
    '(ถ้ามีอยู่แล้วจะ error ไม่เขียนทับ) และบางคำสั่งใน sync script กับคำสั่ง DROP ใน rollback script จะถูก comment ไว้ให้ตรวจก่อนรัน': '(an existing object causes an error instead of being overwritten). Some sync commands and rollback DROP commands are commented out for review',
    'Sync script ทั้งหมด': 'Combined sync script',
    'รวม sync script ของทุก database ที่มีของต้องสร้างหรือแก้ไว้ในไฟล์เดียว': 'Combines sync scripts for all databases needing additions or changes.',
    'เปิดใน SSMS ที่ต่อกับ server target แล้วรันทีเดียวได้ แต่ละส่วนเริ่มด้วย USE ของ database นั้น': 'Run in SSMS connected to the target server. Each section starts with USE for its database.',
    'ถ้าเข้า database ไหนไม่ได้ script จะหยุดทั้งไฟล์ database ที่ไม่มีอะไรต้องแก้ไม่ได้ใส่ไว้ (รายชื่ออยู่ที่หัวไฟล์)': 'The entire script stops if a database is inaccessible. Unchanged databases are omitted and listed in the header.',
    'ส่วน': 'The',
    'Rollback script ทั้งหมด': 'Combined rollback script',
    'ใช้ย้อนหลังรัน Sync script ทั้งหมดแล้ว': 'reverts changes after running the combined sync script',
    'เปิดรายงานแล้วติ๊กรายการที่ต้องการ จะได้ทั้ง sync script และ rollback script ของที่เลือก': 'Open the report and select rows to generate their sync and rollback scripts',
    'รายงาน': 'Report',
    'sync script ทั้งฐาน': 'Full database sync script',
    'sync script เลือกเอง': 'Selected sync script',
    'rollback script ทั้งฐาน': 'Full database rollback script',
    'เริ่ม': 'Started',
    'หมวดที่เปรียบเทียบ:': 'Compared categories:',
    '&middot; ตั้งเวลา:': '&middot; Scheduled job:',
    'การรันล้มเหลว': 'Run failed',
    'ดูรายละเอียดใน log': 'See the log for details',
    'เปิดรายงาน': 'Open report',
    'ดาวน์โหลด .sql': 'Download .sql',
    'ดาวน์โหลด sync .sql': 'Download sync .sql',
    'ดาวน์โหลด rollback .sql': 'Download rollback .sql',
    'Sync script เลือกเอง': 'Selected sync script',
    'ดาวน์โหลด sync ทั้งหมด .sql': 'Download combined sync .sql',
    'ดาวน์โหลด rollback ทั้งหมด .sql': 'Download combined rollback .sql',
    'ฐาน ตัวเลขด้านบนนับเฉพาะฐานที่เทียบได้': 'databases. The counts above include successful comparisons only.',
    'ฐานที่เทียบไม่สำเร็จไม่มีรายงานและไม่มี script สาเหตุของแต่ละฐานอยู่ในตารางด้านล่าง': 'Failed databases have no report or scripts. See each error in the table below',
    'ผลไม่ครบ: login อย่างน้อยหนึ่งฝั่งไม่มีสิทธิ์ VIEW DEFINITION ของที่ login มองไม่เห็นจะขึ้นเป็น': 'Incomplete: at least one login lacks VIEW DEFINITION permission. Hidden objects may appear as',
    'หรือ': 'or',
    'ทั้งที่อาจมีอยู่จริง และโค้ดที่อ่านไม่ได้จะขึ้นเป็น': 'even when they exist. Unreadable code is marked as',
    'สร้าง sync script ไม่สำเร็จ:': 'Failed to generate sync script:',
    'สร้าง rollback script ไม่สำเร็จ:': 'Failed to generate rollback script:',
    'ผลลัพธ์': 'Result',
    'ฐานที่มีแค่บน server ต้นแบบ (source):': 'Databases on the source server only:',
    'ฐานที่มีแค่บน server ปลายทาง (target):': 'Databases on the target server only:',
    'มีทั้งสองฝั่งแต่ login เข้าไม่ได้': 'Present on both sides but inaccessible to this login:',
    'ฐาน จึงไม่ได้เทียบ:': 'databases were not compared:',
    'ประวัติการเปรียบเทียบ': 'Comparison history',
    'ยังไม่มีประวัติ เริ่มจากหน้า': 'No runs yet. Start on the',
    'เวลา': 'Time',
    'ประเภท': 'Type',
    'สถานะ': 'Status',
    'ลบ': 'Delete',
    'ลบ run ออกจากประวัติแล้ว แต่ไฟล์บางส่วนยังลบไม่ได้ (อาจมีโปรแกรมอื่นเปิดอยู่) ระบบจะลบที่เหลือให้เองตอนเปิด server ครั้งถัดไป หรือรอบล้างประวัติประจำวัน ยกเว้นเมื่อรันด้วย npm run dev ซึ่งไม่ลบอะไรเลย': 'The run was removed from history, but some files are still in use. They will be removed at the next server start or daily cleanup, except in npm run dev, which never deletes files',
    'ดูว่า schema ของฐานหนึ่งเปลี่ยนไปอย่างไรระหว่างสองช่วงเวลา ใช้ snapshot ที่เก็บไว้ทุกครั้งที่รันเปรียบเทียบ': 'Track schema changes between two points in time using snapshots saved with each comparison',
    'ยังไม่มี snapshot รันการเปรียบเทียบอย่างน้อยหนึ่งครั้งก่อน': 'No snapshots yet. Run a comparison first',
    'เทียบ drift': 'Compare drift',
    'ดูการรันที่เก็บ snapshot นี้': 'View the run that saved this snapshot',
    'เวลาที่เก็บ snapshot': 'Snapshot time',
    'ถึง ปัจจุบัน': 'To now',
    'ปัจจุบัน (อ่านจากฐานจริงตอนนี้)': 'Now (read the live database)',
    'คือจุดเริ่ม': 'is the starting point;',
    'คือจุดที่จะเทียบ: ผลจะแสดงสิ่งที่เพิ่มขึ้นมา หายไป หรือถูกแก้ ระหว่างสองจุด': 'is the ending point. Results show additions, removals and changes between them',
    'เลือกจุด': 'Select different',
    'กับ': 'and',
    'ให้ต่างกัน': 'points',
    'จ': 'Mon', 'อ': 'Tue', 'พ': 'Wed', 'พฤ': 'Thu', 'ศ': 'Fri', 'ส': 'Sat', 'อา': 'Sun',
    'ทุก': 'Every',
    'ทุกวัน เวลา': 'Every day at',
    'ตั้งเวลารันอัตโนมัติ': 'Scheduled comparisons',
    'ใช้ Windows Task Scheduler รันเป็น user นี้ ขณะที่ login อยู่ ผลจะเข้าไปอยู่ในหน้าประวัติ (ไม่ต้องเปิดเว็บนี้ค้างไว้)': 'Windows Task Scheduler runs as this user while logged in. Results appear in History; the browser can be closed',
    'สร้างงานใหม่': 'New job',
    'ยังไม่มีงานที่ตั้งเวลาไว้': 'No scheduled jobs yet',
    'ชื่องาน': 'Job name',
    'รอบถัดไป': 'Next run',
    'ผลล่าสุด': 'Latest result',
    'รันตอนนี้': 'Run now',
    'แก้ไข': 'Edit',
    'ปิดอยู่': 'Disabled',
    'ไม่พบใน Task Scheduler': 'Not found in Task Scheduler',
    'ยังไม่เคยรัน': 'Never run',
    'เช่น local เทียบ test ทุกคืน': 'e.g. local vs test every night',
    'ทุกวัน': 'Daily',
    'บางวัน': 'Weekly',
    'เวลา (24 ชม.)': 'Time (24-hour)',
    'เปิดใช้งาน': 'Enabled',
    'บันทึก': 'Save',
    'ยกเลิก': 'Cancel',
    'แก้ไขงาน': 'Edit job',
    'งานใหม่': 'New job',
    'ต่อได้ instance': 'Connected to instance',
    'ไม่ใช่': 'instead of',
    'ที่ตั้งไว้:': 'as configured:',
    'เมื่อใส่ port ด้วย SQL Server จะต่อตาม port โดยไม่ดูชื่อ instance ให้แก้ server นี้ ลบ port ออก หรือใส่ port จริงของ': 'With a port specified, SQL Server ignores the instance name. Edit this server: remove the port or enter the actual port for',
    'เชื่อมต่อได้': 'Connected',
    '&middot; เข้าได้': '&middot; Accessible:',
    'ฐาน &middot; VIEW ANY DEFINITION:': 'databases &middot; VIEW ANY DEFINITION:',
    'มี': 'Yes',
    'ไม่มี': 'No',
    'ฐานที่เข้าได้: ผลเทียบของฐานเหล่านั้นจะไม่ครบ': 'accessible databases: their comparison results will be incomplete',
    'รหัสผ่านของ server ที่สร้างที่นี่เข้ารหัสด้วย Windows DPAPI: เปิดได้เฉพาะ Windows user นี้บนเครื่องนี้': 'Saved server passwords use Windows DPAPI encryption and can only be decrypted by this Windows user on this computer',
    'เพิ่ม server': 'Add server',
    'ในตัว': 'Built-in',
    'สร้างที่นี่': 'Saved here',
    'mssql-mcp (อ่านอย่างเดียว)': 'mssql-mcp (read-only)',
    'ชื่อ': 'Name',
    'ที่มา': 'Origin',
    'profile ของ mssql-mcp อ่านจาก ~/.config/mssql-mcp/*.env (แก้ที่ไฟล์นั้น)': 'mssql-mcp profiles are read from ~/.config/mssql-mcp/*.env (edit the profile file)',
    'ทดสอบ': 'Test',
    'กำลังทดสอบ...': 'Testing...',
    'ชื่อ (ไว้เรียก)': 'Display name',
    'เช่น test-197': 'e.g. test-197',
    'Host หรือ IP': 'Host or IP',
    'การยืนยันตัวตน': 'Authentication',
    'ทดสอบการเชื่อมต่อ': 'Test connection',
    'แก้ไข server': 'Edit server',
    'เว้นว่าง = ใช้รหัสเดิม': 'Leave blank to keep the current password',
    'ใส่ทั้งชื่อ instance (': 'Both an instance name (',
    ') และ port: SQL Server จะต่อตาม port โดยไม่ดูชื่อ instance': ') and port are specified: SQL Server connects by port and ignores the instance name.',
    'ถ้า port': 'If port',
    'ไม่ใช่ของ': 'does not belong to',
    'จะได้ instance อื่นบนเครื่องเดียวกันแทน': 'another instance on the same host may answer.',
    'เว้น port ว่างไว้ ให้หา instance จากชื่อ (ผ่าน SQL Browser) หรือใส่ port จริงของ': 'Leave the port blank to resolve the instance through SQL Browser, or enter the actual port for',
  };

  let language = 'th';
  try { if (localStorage.getItem(KEY) === 'en') language = 'en'; } catch { /* Storage may be blocked. */ }

  function part(text) {
    if (language === 'th') return text;
    // Keep tags, attribute quotes and whitespace exactly as authored. This also handles HTML
    // fragments on either side of a template interpolation without translating its value.
    return text.split(/([<>"\n])/).map(piece => {
      const key = piece.trim();
      return Object.hasOwn(EN, key) ? piece.replace(key, EN[key]) : piece;
    }).join('');
  }

  function t(message, ...values) {
    if (typeof message === 'string') return part(message);
    return message.reduce((text, chunk, index) => text + part(chunk) + (index < values.length ? values[index] : ''), '');
  }

  function apply() {
    if (typeof document === 'undefined') return;
    document.documentElement.lang = language;
    document.querySelectorAll('[data-i18n]').forEach(element => { element.textContent = t(element.dataset.i18n); });
    document.querySelectorAll('[data-language-select]').forEach(select => {
      select.value = language;
      select.setAttribute('aria-label', t('ภาษา'));
      select.title = t('ภาษา');
    });
  }

  function setLanguage(value) {
    if (!['th', 'en'].includes(value) || value === language) return;
    language = value;
    try { localStorage.setItem(KEY, value); } catch { /* Still works for this page load. */ }
    apply();
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('languagechange'));
  }

  globalThis.DatabaseDiffI18n = { t, setLanguage, get language() { return language; } };
  apply();
  if (typeof document !== 'undefined') document.querySelectorAll('[data-language-select]').forEach(select => {
    select.addEventListener('change', () => setLanguage(select.value));
  });
})();
