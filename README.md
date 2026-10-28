# database-diff

ระบบเปรียบเทียบ schema ของ SQL Server (table, column, index, FK, check, view, SP, function, trigger, type, sequence, synonym) ทั้งในเซิร์ฟเวอร์เดียวกันและข้ามเซิร์ฟเวอร์ มีทั้งหน้าเว็บบนเครื่องนี้และ command line
ทำงานแบบ **read-only**: อ่านจาก catalog views (`sys.*`) อย่างเดียว ไม่แก้ไขฐานใดๆ ส่วน sync script และ rollback script ที่สร้างขึ้นมา ระบบไม่รันให้เอง

ต้องมี: Windows PowerShell 5.1 (มากับ Windows) และ Node.js สำหรับหน้าเว็บ ไม่ต้องติดตั้ง package เพิ่ม

## หมวดที่เปรียบเทียบ

ค่าเริ่มต้นเทียบ 5 หมวดหลัก: **Table, Column, View, Stored procedure, Function**
หมวดอื่น (Index, Foreign key, Check constraint, Trigger, User-defined type, Sequence, Synonym, Schema, Database settings) ติ๊กเพิ่มได้ในหน้าเว็บ หรือใช้ `-Categories` ใน command line
- ระบบยังอ่านทุกหมวดเสมอ (หมวดที่ไม่ได้เลือกใช้เวลาอ่านแค่ราว 0.3 วินาทีต่อฝั่ง) แต่เทียบและรายงานเฉพาะหมวดที่เลือก snapshot จึงครบทุกหมวด ทำให้ drift ทีหลังเลือกหมวดไหนก็ได้
- sync script ของตารางใหม่ยังใส่ primary key ใน `CREATE TABLE` เสมอ ส่วน index / FK / check ของตารางนั้นจะสร้างเฉพาะเมื่อเลือกหมวดนั้นไว้
- ถ้าไม่ได้เลือกหมวด Schema แต่ object ใหม่อยู่ใน schema อื่นที่ไม่ใช่ dbo ใน script จะมีคำสั่งสร้าง schema ให้ (สร้างเฉพาะเมื่อยังไม่มี)

## เริ่มใช้หน้าเว็บ

ดับเบิลคลิก `start.cmd` (หรือรัน `node app\server.js --open`) แล้วเปิด http://127.0.0.1:4870/
เว็บเปิดได้เฉพาะจากเครื่องนี้ (bind 127.0.0.1) ปิดหน้าต่าง console เมื่อเลิกใช้ ถ้า port ชนให้ตั้ง `PORT` เป็นค่าอื่น

| หน้า | ใช้ทำอะไร |
|---|---|
| เปรียบเทียบ | เลือก server/ฐานทั้งสองฝั่ง แบบฐานเดียวหรือหลายฐาน (batch) กดเริ่มแล้วดู log สด ได้รายงาน HTML + sync script + rollback script |
| ประวัติ | ผลทุกครั้งที่รัน (ทั้งกดเองและตั้งเวลา) เปิดรายงานย้อนหลังได้ |
| Schema drift | เทียบ schema ของฐานเดียวกันระหว่างสองช่วงเวลา (snapshot เก่า กับ snapshot อื่นหรือฐานจริงตอนนี้) |
| ตั้งเวลา | ตั้งให้รันเปรียบเทียบอัตโนมัติทุกวันหรือบางวัน ผ่าน Windows Task Scheduler |
| Servers | เพิ่ม/แก้/ทดสอบ server รหัสผ่านเข้ารหัสด้วย Windows DPAPI |

### Servers

- `localhost (Windows auth)` มีให้ในตัว
- profile ของ mssql-mcp ใน `~\.config\mssql-mcp\*.env` ขึ้นมาให้เลือกอัตโนมัติ (อ่านอย่างเดียว ต้องแก้ที่ไฟล์)
- server ที่เพิ่มจากหน้าเว็บเก็บใน `data\servers\*.json` รหัสผ่านเข้ารหัสด้วย DPAPI: ถอดได้เฉพาะ Windows user นี้บนเครื่องนี้ (ไฟล์ copy ไปเครื่องอื่นใช้ไม่ได้)

### ตั้งเวลา

- สร้าง task ชื่อ `\database-diff\job-<id>` ใน Task Scheduler รันเป็น user นี้ **เฉพาะตอนที่ login อยู่** (ไม่ต้องเก็บรหัส Windows และใช้ DPAPI ได้)
- ไม่ต้องเปิดเว็บค้างไว้ ผลจะเข้าไปอยู่ในหน้าประวัติ
- ปิดหรือลบงานจากหน้าเว็บ task จะถูกลบตาม

### Sync script

ทุกครั้งที่เปรียบเทียบจะได้ไฟล์ `.sync.sql` ซึ่งถ้ารันบนฝั่ง **target** จะทำให้ schema ตรงกับ **source**
- ระบบไม่รัน script ให้ ต้อง review แล้วรันเองใน SSMS และ backup target ก่อน
- คำสั่งที่ลบของ (DROP TABLE / DROP COLUMN / DROP PROCEDURE ...) ถูก **comment ไว้** ท้ายไฟล์
- `ALTER COLUMN` เปิดใช้งานอยู่: ต้องเช็คเองว่าไม่ทำข้อมูลหาย (type แคบลง หรือเปลี่ยนเป็น NOT NULL)
- เรียงตามชนิด object ไม่ได้เรียงตาม dependency ถ้าบางส่วนล้มเหลว ให้รันส่วนนั้นซ้ำหลังส่วนอื่น
- view / SP / function / trigger ใช้ `CREATE OR ALTER` (ต้องเป็น SQL Server 2016 SP1 ขึ้นไป) ยกเว้น object ที่เปลี่ยนชนิด (เช่น scalar function เป็น table-valued) ซึ่ง ALTER ทำไม่ได้: ไฟล์จะมี `DROP` ที่ comment ไว้ให้ แล้วต้องรัน definition จากรายงานเอง
- ตารางใหม่ถูกสร้างพร้อม primary key แต่ index / FK / check จะถูกสร้างก็ต่อเมื่อเลือกหมวดนั้นด้วย
- รายการที่ "เทียบไม่ได้" จะไม่ถูกสร้างคำสั่ง แต่จะลิสต์ไว้ในไฟล์
- ในหน้า drift ไฟล์เดียวกันนี้คือ "script ย้อนกลับ": ทำให้ฝั่ง "ถึง" กลับไปเป็นแบบ "จาก"

### Rollback script

ทุกครั้งที่เปรียบเทียบจะได้ไฟล์ `.rollback.sql` คู่กับ `.sync.sql` ใช้ย้อนผลของ sync script: รันบนฝั่ง **target** หลังรัน sync script แล้ว schema จะกลับไปเป็นแบบตอนที่เปรียบเทียบ (สร้างจาก snapshot ของ target ก่อน sync)
- ใช้ได้ถูกต้องเมื่อหลังเปรียบเทียบ target ถูกแก้โดย sync script เท่านั้น ถ้ามีคนแก้อย่างอื่นด้วย ให้เปรียบเทียบใหม่
- object ที่ sync script **แก้** (column, index, check, FK, view, SP, function, trigger, synonym, sequence) ถูกแก้กลับเป็นแบบเดิม
- object ที่ sync script **สร้างใหม่**:
  - procedure / view / function / trigger / synonym / index / FK / check ถูก DROP จริงตั้งแต่ต้นไฟล์ ใช้ `DROP ... IF EXISTS` จึงรันได้แม้ sync script หยุดกลางทาง หรือรัน rollback ซ้ำ
  - table / column / sequence / type / schema ถูก **comment ไว้** ท้ายไฟล์ เพราะลบแล้วข้อมูลที่เขียนเข้ามาหลัง sync หายด้วย
  - constraint ที่ระบบตั้งชื่อเอง (ไม่มีชื่อใน source) ได้ชื่อใหม่ตอน sync จึงลบด้วยชื่อไม่ได้: ไฟล์จะมีหมายเหตุให้หาชื่อแล้วลบเอง
- object ที่มีแค่ฝั่ง target ไม่อยู่ใน rollback เพราะ sync script ไม่ได้ลบมัน (DROP ถูก comment ไว้) ถ้าไป uncomment แล้วรัน ต้องกู้จาก backup
- schema ที่ sync script สร้างให้ "เฉพาะเมื่อยังไม่มี" (กรณีไม่ได้เลือกหมวด Schema) ไม่ถูกลบ
- ข้อมูลที่หายไปแล้ว (เช่นจาก ALTER COLUMN ที่แคบลง) rollback กู้คืนไม่ได้ ต้องใช้ backup
- หน้า drift ไม่มีปุ่ม rollback เพราะ script ของหน้านั้นเป็น script ย้อนกลับอยู่แล้ว

## Command line

เครื่องนี้ execution policy เป็น Restricted จึงต้องรันผ่าน `powershell -ExecutionPolicy Bypass -File` (ให้ `cd D:\projects\database-diff` ก่อน)

```powershell
# Batch: ทุกฐานที่ชื่อตรงกันทั้ง local และ 197 + index.html
powershell -ExecutionPolicy Bypass -File .\Compare-Database.ps1 -TargetProfile pylon-197 -AllDatabases -Open

# Batch: เฉพาะฐานที่เลือก
powershell -ExecutionPolicy Bypass -File .\Compare-Database.ps1 -TargetProfile pylon-197 -Databases plapp_prod,pldata -Open

# ฐานเดียว local เทียบกับ 197 (ชื่อฐานเดียวกันทั้งสองฝั่ง)
powershell -ExecutionPolicy Bypass -File .\Compare-Database.ps1 -SourceDatabase plapp_prod -TargetProfile pylon-197 -Open

# สองฐานในเซิร์ฟเวอร์เดียวกัน
powershell -ExecutionPolicy Bypass -File .\Compare-Database.ps1 -SourceDatabase plapp_dev -TargetDatabase plapp_prod -Open

# เลือกหมวดเอง (คั่นด้วยคอมม่า ใช้ชื่อย่อได้: sp, fk, check, type) หรือ All
powershell -ExecutionPolicy Bypass -File .\Compare-Database.ps1 -SourceDatabase plapp_dev -TargetDatabase plapp_prod -Categories table,column,sp,index,fk
powershell -ExecutionPolicy Bypass -File .\Compare-Database.ps1 -SourceDatabase plapp_dev -TargetDatabase plapp_prod -Categories All

# เก็บ snapshot ไว้ แล้วเทียบกับฐานจริงทีหลัง (drift)
powershell -ExecutionPolicy Bypass -File .\Compare-Database.ps1 -SourceDatabase plapp_dev -TargetDatabase plapp_prod -SaveSnapshots
powershell -ExecutionPolicy Bypass -File .\Compare-Database.ps1 -SourceSnapshot .\reports\<ไฟล์>.source.snapshot.json -TargetDatabase plapp_dev

# รายชื่อฐาน + สิทธิ์ เป็น JSON (ใช้ทดสอบการเชื่อมต่อได้)
powershell -ExecutionPolicy Bypass -File .\Compare-Database.ps1 -ListDatabases -SourceProfile pylon-197
```

ดูพารามิเตอร์ทั้งหมด: `powershell -ExecutionPolicy Bypass -Command "Get-Help .\Compare-Database.ps1 -Full"`

ผลลัพธ์ของแต่ละการเทียบ: `.html` (รายงาน), `.json` (ข้อมูลดิบ), `.sync.sql`, `.rollback.sql` และถ้าใส่ `-SaveSnapshots` จะได้ `.source.snapshot.json` / `.target.snapshot.json` ด้วย

### Profile

`-SourceProfile` / `-TargetProfile` รับชื่อ (หาใน `~\.config\mssql-mcp\<ชื่อ>.json` แล้วค่อย `<ชื่อ>.env`) หรือ path ของไฟล์
- `.env` รูปแบบ mssql-mcp: `MSSQL_SERVER`, `MSSQL_PORT`, `MSSQL_USER` (เว้นว่าง = Windows auth), `MSSQL_PASSWORD`, `MSSQL_ENCRYPT`, `MSSQL_TRUST_CERT`
- `.json` รูปแบบที่หน้าเว็บสร้าง (รหัสผ่านเป็น DPAPI)

### ตัวเลือก

| พารามิเตอร์ | ผล |
|---|---|
| `-Categories <รายการ>` | หมวดที่เทียบ (default: Table, Column, View, Stored procedure, Function) |
| `-IgnoreWhitespace` | ถือว่าช่องว่างหลายตัวติดกันเท่ากับช่องเดียว |
| `-IgnoreCase` | ไม่สนตัวพิมพ์เล็ก/ใหญ่ |
| `-IgnoreCollation` | ไม่เทียบ collation (เซิร์ฟเวอร์ที่ default collation ต่างกัน) |
| `-CompareColumnOrder` | รายงานคอลัมน์ที่ลำดับต่างกันด้วย |
| `-TrustServerCertificate` | สำหรับเซิร์ฟเวอร์ที่บังคับ encrypt ด้วย self-signed cert |
| `-QueryTimeout <วินาที>` | timeout ต่อ query (default 120) |
| `-Open` / `-PassThru` | เปิดรายงานเมื่อเสร็จ / ส่ง record ผลต่างออก pipeline |

## กติกาการเทียบที่ลดผลต่างหลอก

- Column / Index / FK / Check เทียบเฉพาะตารางที่มีทั้งสองฝั่ง (ตารางที่ขาดรายงานครั้งเดียวในหมวด Table)
- Constraint ที่ระบบตั้งชื่อเอง (`PK__Orders__3214EC07...`) จับคู่ด้วยตาราง + นิยาม ไม่ใช้ชื่อ ถ้านิยามตรงแต่ชื่อต่าง รายงานเป็น `Name: source a, target b`
- Definition ถูก normalize ก่อนเทียบ: line ending, ช่องว่างท้ายบรรทัด, บรรทัดว่างหัวท้าย, `CREATE OR ALTER` นับเป็น `CREATE` (sync script ยังใช้ข้อความดิบ ไม่ตัดช่องว่างใน string literal)
- ชื่อตารางและคอลัมน์จับคู่แบบไม่สนตัวพิมพ์ (ตรงกับ collation แบบ CI) ชื่อที่ต่างแค่ตัวพิมพ์ (`Id` กับ `id`) จึงไม่ถูกรายงาน และรายชื่อคอลัมน์ใน index / FK ก็เทียบแบบไม่สนตัวพิมพ์เช่นกัน
- ข้าม object ของ SSMS diagram: ดูจาก extended property `microsoft_database_tools_support` ที่ SSMS ใส่ไว้ (ปกติคือ `sysdiagrams`, `sp_*diagram*`, `fn_diagramobjects`) รวมถึงคอลัมน์และ index ของ `sysdiagrams` ด้วย

## สถานะในรายงาน

- **Only in source / Only in target** (มีแค่ source / มีแค่ target)
- **Different** (ต่างกัน): ปุ่ม "Show diff" แสดง diff ของ definition ทีละบรรทัด
- **Cannot compare** (เทียบไม่ได้): ค่าฝั่งใดฝั่งหนึ่งอ่านไม่ได้ (encrypted, CLR หรือไม่มีสิทธิ์) **ไม่นับเป็นผลต่าง**

Exit code ของ command line: `0` = เหมือนกันและเทียบได้ครบ, `1` = มีผลต่าง หรือเทียบได้ไม่ครบ, `2` = error

## สำคัญ: สิทธิ์ VIEW DEFINITION

Login ทั้งสองฝั่งควรมี `VIEW DEFINITION` ในฐานที่เทียบ (หรือ `VIEW ANY DEFINITION` ระดับเซิร์ฟเวอร์) ถ้าไม่มี SQL Server จะ
1. ซ่อน object ที่ login ไม่มีสิทธิ์อื่นเลย ทำให้ขึ้นเป็น "มีแค่..." ทั้งที่จริงมีอยู่
2. คืน definition ของ view / SP / default / check เป็น NULL ทำให้ขึ้นเป็น "เทียบไม่ได้"

ระบบตรวจสิทธิ์ให้อัตโนมัติ และขึ้นเตือนในหน้าเว็บ รายงาน และหัว sync script

## ไฟล์ในโปรเจกต์

| path | คือ |
|---|---|
| `Compare-Database.ps1` | engine (อ่าน schema, เทียบ, เขียนรายงาน) |
| `lib\SyncScript.ps1` | สร้าง sync script และ rollback script |
| `templates\` | template ของรายงาน HTML |
| `app\` | หน้าเว็บ (Node, ไม่มี dependency) และ `cli.js` / `run-job.ps1` สำหรับงานตั้งเวลา |
| `data\` | ประวัติการรัน, snapshot, profile ของ server, งานตั้งเวลา (ไม่เข้า git) |
| `reports\` | ผลของการรันจาก command line (ไม่เข้า git) |
