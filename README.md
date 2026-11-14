# database-diff

ระบบเปรียบเทียบ schema ของ SQL Server (table, column, index, FK, check, view, SP, function, trigger, type, sequence, synonym) ทั้งในเซิร์ฟเวอร์เดียวกันและข้ามเซิร์ฟเวอร์ มีทั้งหน้าเว็บบนเครื่องนี้และ command line
ทำงานแบบ **read-only**: อ่านจาก catalog views (`sys.*`) อย่างเดียว ไม่แก้ไขฐานใดๆ ส่วน sync script และ rollback script ที่สร้างขึ้นมา ระบบไม่รันให้เอง

ต้องมี: Windows PowerShell 5.1 (มากับ Windows) และ Node.js 22 ขึ้นไปสำหรับหน้าเว็บ หน้าเว็บไม่ต้องติดตั้ง package เพิ่ม ส่วน test ต้อง `npm install` ก่อน (ดู [Test](#test))

## หมวดที่เปรียบเทียบ

ค่าเริ่มต้นเทียบ 5 หมวดหลัก: **Table, Column, View, Stored procedure, Function**
หมวดอื่น (Index, Foreign key, Check constraint, Trigger, User-defined type, Sequence, Synonym, Schema, Database settings) ติ๊กเพิ่มได้ในหน้าเว็บ หรือใช้ `-Categories` ใน command line
- ระบบยังอ่านทุกหมวดเสมอ (หมวดที่ไม่ได้เลือกใช้เวลาอ่านแค่ราว 0.3 วินาทีต่อฝั่ง) แต่เทียบและรายงานเฉพาะหมวดที่เลือก snapshot จึงครบทุกหมวด ทำให้ drift ทีหลังเลือกหมวดไหนก็ได้
- sync script ของตารางใหม่ยังใส่ primary key ใน `CREATE TABLE` เสมอ ส่วน index / FK / check ของตารางนั้นจะสร้างเฉพาะเมื่อเลือกหมวดนั้นไว้
- ถ้าไม่ได้เลือกหมวด Schema แต่ object ใหม่อยู่ใน schema อื่นที่ไม่ใช่ dbo ใน script จะมีคำสั่งสร้าง schema ให้ (สร้างเฉพาะเมื่อยังไม่มี)
- index ของ view (indexed view) อยู่ในหมวด Index เหมือน index ของตาราง และ database trigger (`CREATE TRIGGER ... ON DATABASE`) อยู่ในหมวด Trigger: ในรายงาน index ของ view อยู่ใต้ view ของมัน ส่วน database trigger อยู่ในส่วน "โค้ดและของอื่น" ชื่อเป็น `ชื่อ (database trigger)`
- snapshot ที่บันทึกก่อน 2026-11-11 (version 1) ไม่มี index ของ view และ database trigger ถ้าฝั่งใดฝั่งหนึ่งเป็น snapshot แบบนั้น สองอย่างนี้จะไม่ถูกเทียบในรอบนั้น (log มีบรรทัด `Note:` บอก) จึงไม่ขึ้นเป็นผลต่างหลอก

## เริ่มใช้หน้าเว็บ

ดับเบิลคลิก `start.cmd` (หรือรัน `node app\server.js --open`) แล้วเปิด http://127.0.0.1:4870/
เว็บเปิดได้เฉพาะจากเครื่องนี้ (bind 127.0.0.1) ปิดหน้าต่าง console เมื่อเลิกใช้ ถ้า port ชนให้ตั้ง `PORT` เป็นค่าอื่น
- ประวัติการรันที่เก่ากว่า 90 วันถูกลบอัตโนมัติ ตอนเปิดเว็บและวันละครั้งขณะเว็บเปิดอยู่ เปลี่ยนจำนวนวันด้วยตัวแปร `DATABASE_DIFF_RETENTION_DAYS` (ใน `start.cmd` มีบรรทัดตัวอย่าง) ค่า `0` คือไม่ลบ ค่าที่ไม่ใช่จำนวนเต็มก็ไม่ลบเช่นกัน และมีคำเตือนใน console
  - 90 วันนับถอยจาก **การรันครั้งล่าสุด** ไม่ใช่จากวันนี้: ช่วงที่ไม่ได้ใช้งาน (หรือนาฬิกาเครื่องที่กระโดดไปข้างหน้า) ไม่ถูกนับเป็นอายุ เปิดเว็บหลังเว้นไปนานจึงไม่ทำให้ประวัติหายทั้งชุด
  - `npm run dev` (รันใต้ `node --watch`) ไม่ลบอะไรเลย เพราะ server restart ทุกครั้งที่แก้โค้ด และโค้ดที่ตัดสินว่าจะลบอะไรอาจแก้ค้างอยู่
  - ไม่ลบ: 20 รายการล่าสุด, รายการที่กำลังรัน, รายการที่งานตั้งเวลาหรือ drift ที่ยังเก็บอยู่ใช้ snapshot ของมัน และ folder ที่ไม่ใช่ของระบบชัดเจน (ชื่อไม่ตรงรูปแบบ, เป็น link, อ่าน `run.json` ไม่ได้ หรือไม่มีวันที่)
  - ทุกรายการที่ลบถูกบันทึกใน `data\retention.log` หน้า "ประวัติ" มีบรรทัดบอกขนาดของประวัติและกติกาที่ใช้อยู่ ส่วนงานตั้งเวลา (`cli.js`) ไม่ลบอะไร
  - การลบ run (ทั้งอัตโนมัติและปุ่ม "ลบ" ในหน้าประวัติ) เป็นแบบ **ลบทั้ง run หรือไม่ลบเลย**: ระบบเปลี่ยนชื่อ folder ของ run เป็น `deleted-<id>` ก่อนแล้วค่อยลบ ถ้ามีโปรแกรมอื่นเปิดไฟล์ของ run นั้นค้างอยู่ Windows จะไม่ยอมให้เปลี่ยนชื่อ run จึงอยู่ครบเหมือนเดิม (ลิงก์รายงานและ snapshot ยังใช้ได้) หน้าประวัติจะบอกว่าลบไม่ได้เพราะไฟล์ถูกใช้อยู่: ปิดไฟล์นั้นแล้วกดลบอีกครั้ง (ถ้าไฟล์ที่เปิดอยู่คือรายงานหรือ script ที่ server กำลังส่งให้ browser อยู่พอดี ปุ่มลบจะรอให้ส่งจบแล้วลบให้เอง) ส่วนการลบอัตโนมัติจะลองใหม่รอบถัดไป
  - folder `deleted-<id>` ที่ค้างอยู่ (เช่น server ถูกปิดระหว่างลบ) ไม่ถูกนับเป็น run และถูกลบให้ตอนเปิดเว็บครั้งถัดไปกับรอบประจำวัน แม้ตั้งค่าไม่ลบประวัติ (`0`) ก็ตาม ยกเว้นเมื่อรันด้วย `npm run dev` ซึ่งไม่ลบอะไรเลย (folder นี้จะอยู่จนกว่าจะเปิด server แบบปกติ)
- ทุก response ของเว็บห้ามแสดงใน frame ของเว็บอื่น (`X-Frame-Options: DENY` และ `Content-Security-Policy: frame-ancestors 'none'`)
- แก้โค้ดของหน้าเว็บ: `npm run dev` เปิดเว็บแบบ restart เองเมื่อแก้ `app\server.js` หรือไฟล์ใน `app\lib\` (ใช้ `node --watch-path` ไม่ต้องติดตั้งอะไรเพิ่ม)

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
- ลบ server ที่ยังมีงานตั้งเวลาใช้อยู่ไม่ได้ (ระบบบอกชื่องาน) ต้องแก้หรือลบงานนั้นก่อน
- address แบบ `host\INSTANCE,port`: SQL Server ต่อตาม port โดยไม่ดูชื่อ instance ถ้า instance ที่ตอบไม่ใช่ชื่อที่ระบุ ปุ่มทดสอบจะเตือน และ **การเปรียบเทียบจะล้มเหลวทันที** (ไม่อ่าน schema ผิดเครื่องมาใส่ชื่อ server นี้) ให้ลบ port ออกหรือใส่ port จริงของ instance นั้น

### ตั้งเวลา

- สร้าง task ชื่อ `\database-diff\job-<id>` ใน Task Scheduler รันเป็น user นี้ **เฉพาะตอนที่ login อยู่** (ไม่ต้องเก็บรหัส Windows และใช้ DPAPI ได้)
- ไม่ต้องเปิดเว็บค้างไว้ ผลจะเข้าไปอยู่ในหน้าประวัติ
- ปิดหรือลบงานจากหน้าเว็บ task จะถูกลบตาม
- ผลของ task (`node app\cli.js run-job <id>`): exit `0` = เทียบครบทุกฐาน, `1` = รันจบแต่มีฐานที่เทียบไม่สำเร็จ (หน้าประวัติขึ้นป้าย "เทียบไม่สำเร็จ N ฐาน" และไม่ขึ้นว่า "เหมือนกัน") หรือรันล้มเหลว, `2` = เริ่มรันไม่ได้ (เช่น profile ของ server ถูกลบ) ซึ่งจะถูกบันทึกเป็น run ที่ล้มเหลวในหน้าประวัติด้วย

### Sync script

ทุกครั้งที่เปรียบเทียบจะได้ไฟล์ `.sync.sql` ซึ่งถ้ารันบนฝั่ง **target** จะทำให้ schema ตรงกับ **source**
- ระบบไม่รัน script ให้ ต้อง review แล้วรันเองใน SSMS และ backup target ก่อน
- คำสั่งที่ลบของ (DROP TABLE / DROP COLUMN / DROP PROCEDURE ...) ถูก **comment ไว้** ท้ายไฟล์
- `ALTER COLUMN` เปิดใช้งานอยู่: ต้องเช็คเองว่าไม่ทำข้อมูลหาย (type แคบลง หรือเปลี่ยนเป็น NOT NULL)
  - ยกเว้น column ที่มี computed column ใช้อยู่: SQL Server ไม่ยอมแก้ (Msg 5074 / 4922) ไม่ว่าจะเปลี่ยน type, ความยาว หรือ NULL / NOT NULL ทั้งชุดจึงถูก **comment ไว้** ให้รันเอง: DROP computed column, `ALTER COLUMN` (รวม default ถ้ามี) แล้ว ADD computed column กลับ ใน transaction เดียว ก่อนรันต้องลบ index / constraint / statistics ที่ใช้ computed column นั้นเอง
  - computed column ใหม่ถูกเพิ่มหลัง column ที่ถูกแก้ เพื่อไม่ให้ไปขวาง `ALTER COLUMN` ของ column ที่มันใช้
- เรียงตามชนิด object ไม่ได้เรียงตาม dependency ถ้าบางส่วนล้มเหลว ให้รันส่วนนั้นซ้ำหลังส่วนอื่น
- ต้นไฟล์มี `USE` ของฐาน target แล้วเช็คว่าเข้าได้จริง ถ้าเข้าไม่ได้ (ต่อผิด server หรือไม่มีสิทธิ์) จะขึ้น error แล้ว `SET NOEXEC ON` หยุดทั้งไฟล์ ไม่มีคำสั่งไหนไปรันในฐานอื่น ท้ายไฟล์มี `SET NOEXEC OFF` คืนค่า session
- ทั้งไฟล์รันใต้ `SET XACT_ABORT ON` (ถ้ารันแค่บางส่วน ให้รันบรรทัดนี้ด้วย) index / constraint / default ที่ต้อง DROP แล้วสร้างใหม่ทำใน transaction เดียว: ถ้าสร้างไม่ผ่าน (ข้อมูลไม่ตรงเงื่อนไข, key ซ้ำ) ของเดิมยังอยู่
  - index ที่เขียนคำสั่งสร้างแทนไม่ได้ (columnstore / XML / spatial หรืออ่าน filter ไม่ได้) จะไม่ถูก DROP: มีแต่ comment ให้ทำเอง
  - constraint ที่ต่างกันแค่เปิด/ปิด ใช้ `CHECK` / `NOCHECK CONSTRAINT` ไม่สร้างใหม่ (มีบรรทัดแบบไม่ตรวจข้อมูลเดิม comment ไว้ให้ เผื่อข้อมูลเดิมไม่ผ่าน)
  - เปลี่ยน type ของ column ที่มี default: DROP default, `ALTER COLUMN` แล้วใส่ default กลับ ใน transaction เดียว (ถ้า default ฝั่งใดฝั่งหนึ่งอ่านไม่ได้ ทั้งชุดจะถูก comment ไว้)
- view / SP / function / trigger ใช้ `CREATE OR ALTER` (ต้องเป็น SQL Server 2016 SP1 ขึ้นไป)
  - ชื่อใน header ถูกเขียนให้ตรงกับชื่อจริงใน catalog เมื่อข้อความเดิมไม่ตรง (object ที่ถูก `sp_rename`, ย้าย schema ด้วย `ALTER SCHEMA ... TRANSFER`, สร้างโดยไม่ระบุ schema หรือ trigger ของตารางที่ถูก rename) ส่วนอื่นของข้อความไม่ถูกแตะ
  - module ที่สร้างด้วย `ANSI_NULLS` หรือ `QUOTED_IDENTIFIER` เป็น OFF จะถูกสร้างภายใต้ค่าเดียวกัน (มี batch `SET` ก่อนและคืนค่าหลัง) และค่าทั้งสองถูกนำมาเทียบด้วย
  - object ที่เปลี่ยนชนิด (เช่น scalar function เป็น table-valued) หรือ trigger ที่อยู่คนละตาราง ALTER ทำไม่ได้: ไฟล์มี `DROP` และ `CREATE` ที่ comment ไว้ให้รันเอง
  - view ที่มี index (indexed view): `ALTER VIEW` ลบ index ของ view นั้นทั้งหมดโดยไม่เตือน script จึงสร้าง index ตามแบบ source ต่อจาก view ที่มันเขียนทุกครั้ง (clustered ก่อน) แม้ไม่ได้เลือกหมวด Index ส่วน index ที่มีแค่ใน target ของ view นั้นจะหายไป (มีหมายเหตุในไฟล์ และ rollback script สร้างคืน)
  - index ของ view ที่ไม่ถูกแก้อยู่ในส่วน "Indexes on views" หลังส่วนของ view: ของใหม่ถูกสร้าง, nonclustered ที่เปลี่ยนถูกแทนที่ใน transaction เดียว ส่วน clustered index ที่เปลี่ยนเป็น comment ให้ทำเอง เพราะการลบมันจะลบ index อื่นของ view ไปด้วย
  - database trigger: ตัวที่เปิดใช้อยู่จะทำงานกับทุกคำสั่งที่ตามหลัง และอาจปฏิเสธคำสั่งนั้นได้ (`RAISERROR` + `ROLLBACK` จบ batch ด้วย Msg 3609) รวมถึง `CREATE` ของ trigger ตัวถัดไปและ `ALTER` ของตัวมันเอง script จึง **`DISABLE` trigger ทุกตัวที่มันจะสร้าง แก้ หรือเปิด เป็นคำสั่งแรกของไฟล์** (มี `IF EXISTS` ตัวใหม่ที่ยังไม่มีจึงถูกข้าม) แล้วสร้างและแก้ใน **ส่วนสุดท้าย** ของไฟล์ โดยตัวใหม่ถูกปิดทันทีหลังสร้าง และ `ENABLE` ตัวที่ source เปิดใช้อยู่เป็นคำสั่งสุดท้าย (`DISABLE` / `ENABLE TRIGGER` ไม่ใช่ DDL event จึงไม่ถูก trigger ตัวไหนปฏิเสธ) คำสั่งทั้งหมดลงท้ายด้วย `ON DATABASE`
    - **รันซ้ำได้**: หลังรันจบไปแล้ว หรือหยุดกลางทาง ให้รันทั้งไฟล์อีกครั้ง trigger ที่รอบก่อนสร้างหรือเปิดไว้จะถูกปิดก่อนเป็นอย่างแรก จึงไม่มาปฏิเสธคำสั่งของรอบนี้ และจบด้วยสถานะเดียวกับการรันรอบเดียว (ของที่รอบก่อนสร้างไว้แล้ว เช่น index หรือตาราง จะขึ้น error ว่ามีอยู่แล้ว เช่น Msg 1913 / 2714 ซึ่งเป็นเรื่องปกติ)
    - **ห้ามรันแบบหยุดเมื่อเจอ error** (`sqlcmd -b`): script จะหยุดที่ error แรก (รวม error "มีอยู่แล้ว" ของการรันซ้ำ) ทั้งที่ปิด trigger ไปแล้วตั้งแต่ต้นไฟล์ trigger พวกนั้นจะยังปิดอยู่ ทุกครั้งที่ script ปิด trigger ที่เปิดอยู่ มันจะพิมพ์คำสั่งเปิดกลับไว้ในข้อความของการรัน พร้อมชื่อฐาน (`USE [ฐาน]; ENABLE TRIGGER ... ON DATABASE;`): ถ้า script หยุดกลางทาง ให้รันซ้ำจนจบ หรือรันคำสั่งที่พิมพ์ไว้เพื่อให้ trigger กลับเป็นแบบก่อนรัน
    - ตั้งแต่คำสั่งแรกจนถึงส่วนสุดท้าย trigger พวกนี้ถูกปิดสำหรับ **ทุก session** ไม่ใช่เฉพาะ session ที่รัน script: ถ้าตัวใดเป็น trigger ที่บันทึก DDL (audit) มันจะไม่บันทึกอะไรเลยตลอดช่วงที่ script รัน
    - กรณี target ไม่มี `VIEW DEFINITION`: ตัวที่ทั้งสองฝั่งมี (ต้องแก้หรือเปิด/ปิด) ถูกปิดเป็นคำสั่งแรกเหมือนกัน ส่วนตัวใหม่ไม่ถูกปิดล่วงหน้า (อาจเป็นของ target เองที่มองไม่เห็น) ดูข้อ `VIEW DEFINITION` ด้านล่าง
    - trigger ของ target ที่ script ไม่ได้แตะ (เหมือนกันทั้งสองฝั่ง หรือมีแค่ใน target) ยังเปิดอยู่ตามเดิม: ถ้าตัวนั้นปฏิเสธ DDL ต้องปิดเองก่อนรัน script (SQL Server 2025 ที่ทดสอบไม่ได้แค่ปฏิเสธด้วย Msg 3609 เสมอไป: ถ้าคำสั่งที่ถูก rollback คือ `ALTER` ของ database trigger ที่ถูกปิดอยู่และตัวมันเองดัก `ALTER_TRIGGER` server จะล่มด้วย access violation, Error 17310)
- ตารางใหม่ถูกสร้างพร้อม primary key แต่ index / FK / check จะถูกสร้างก็ต่อเมื่อเลือกหมวดนั้นด้วย
- ถ้าไม่ได้เลือกหมวด User-defined type / Sequence แต่ตารางหรือคอลัมน์ใหม่ใช้ type หรือ sequence (ใน default) ที่ target ยังไม่มี script จะสร้างให้ (เฉพาะเมื่อยังไม่มี)
- sequence ชนิด decimal / numeric ถูกสร้างพร้อม precision (`AS decimal(28,0)`) เพราะ `AS decimal` เฉยๆ คือ decimal(18,0) ซึ่งรับค่า MIN / MAX ของ sequence ที่กว้างกว่าไม่ได้
- table type ถูกสร้างพร้อม IDENTITY, default, computed column, collation ของ column, primary key / unique (รวม `IGNORE_DUP_KEY`) และ check (ไม่อ่าน index ที่ไม่ใช่ constraint และ `MEMORY_OPTIMIZED`) ถ้ามาจาก snapshot เก่าที่มีแต่ column จะมีหมายเหตุบอกในไฟล์
- default ที่ตั้งชื่อไว้ (`DF_Orders_Amount`) ถูกสร้างด้วยชื่อเดิม ส่วน default ที่ระบบตั้งชื่อเองถูกสร้างแบบไม่มีชื่อ ชื่อของ default ไม่ถูกนำมาเทียบ (ถ้าต่างกันแค่ชื่อจะไม่มีรายงาน) snapshot ที่บันทึกก่อน 2026-10-28 ไม่มีชื่อ default จึงสร้างแบบไม่มีชื่อ
- computed column ที่ต่างกันแค่ `PERSISTED` ใช้ `ALTER COLUMN ... ADD/DROP PERSISTED` ส่วน computed ที่นิยาม, type หรือ NOT NULL ต่างกัน ALTER ไม่ได้: มีแต่ comment (computed ใหม่ที่เป็น `PERSISTED NOT NULL` ถูกสร้างครบ)
- column ของ user-defined type ไม่ใส่ `COLLATE` (SQL Server ไม่ยอม) ถ้าต่างกันแค่ collation จะเป็น comment
- synonym ที่ชี้ไปฐานอื่นหรือ server อื่น (ชื่อ 3-4 ส่วน) ถูก **comment ไว้** เพราะชื่อฐานมักต่างกันในแต่ละ environment
- ถ้า login ฝั่ง target ไม่มี `VIEW DEFINITION` (ผลเทียบไม่ครบ) script จะระวังของที่อาจมีอยู่แล้วแต่มองไม่เห็น: view / SP / function / trigger ที่ขึ้นเป็น "ต้องเพิ่ม" (มีแค่ source) ใช้ `CREATE` ธรรมดา (ถ้ามีอยู่แล้วจะ fail แทนที่จะเขียนทับ) ส่วน index / check / FK ของตารางใหม่ และ check ที่ไม่มีชื่อ ถูก comment พร้อมบอกว่าต้องเช็คอะไรก่อนรัน
  - database trigger: login แบบนี้มองไม่เห็น database trigger เลย ทุกตัวจึงขึ้นเป็น "ต้องเพิ่ม" script ใช้ `CREATE` ธรรมดา แล้ว `DISABLE` / `ENABLE` **เฉพาะตัวที่รอบนี้สร้างเองจริง**: ก่อน `CREATE` แต่ละตัว script จดลงตารางชั่วคราวของ session (`#database_diff_created`) ว่าตอนนั้นยังไม่มี trigger ชื่อนี้ ตัวที่มีอยู่แล้ว (CREATE fail ด้วย Msg 2714) จะไม่ถูกแตะเลย: ไม่แก้ ไม่เปิด ไม่ปิด ถ้าตัวนั้นปฏิเสธ DDL ต้องปิดเองก่อนรัน script บน target แบบนี้ Msg 2714 จึงเป็นเรื่องปกติ **ห้ามรันแบบหยุดเมื่อเจอ error** (`sqlcmd -b`): script จะหยุดที่ตัวแรก แล้วทิ้ง trigger ที่มันสร้างหรือกำลังแก้ไว้ในสถานะปิด ทุกครั้งที่ script สร้าง trigger หรือปิด trigger ที่เปิดอยู่ มันจะพิมพ์คำสั่งเปิดกลับไว้ในข้อความของการรัน พร้อมชื่อฐาน (`USE [ฐาน]; ENABLE TRIGGER ... ON DATABASE;` วางรันในหน้าต่าง query ใหม่ได้เลย และแยกฐานกันได้ใน script รวมของ batch) ถ้า script หยุดกลางทาง: รันซ้ำให้จบ แล้วรันคำสั่งที่พิมพ์ไว้ของ trigger ที่มันสร้าง (ตัวที่ต้องแก้ การรันซ้ำจนจบเปิดให้เอง ตารางชั่วคราวหายไปพร้อม session มีแต่การรันซ้ำในหน้าต่าง query เดิมที่เปิดกลับให้เอง ถ้ารันใน session อื่น script จะพิมพ์ `WARNING` สำหรับ trigger ทุกตัวที่มันพบว่าปิดอยู่ รวมตัวที่ปิดอยู่เดิมตั้งแต่แรก: ให้เปิดเฉพาะตัวที่การรันรอบที่หยุดไปพิมพ์ไว้ว่ามันสร้าง)
- column ที่ชนิดเป็น user-defined type ซึ่ง login มองไม่เห็น (ไม่มีสิทธิ์บน type นั้น) ยังถูกอ่านเป็น column ที่มีอยู่ แต่ชนิดขึ้นเป็น "อ่านไม่ได้" และไม่ถูกนำมาเทียบ: script ไม่ `ADD` column นั้นซ้ำ และไม่เขียน `ALTER COLUMN` ให้ (ต้องระบุชนิดซึ่งไม่รู้) มีแต่ comment
- รายการที่ "ตรวจไม่ได้" จะไม่ถูกสร้างคำสั่ง แต่จะลิสต์ไว้ในไฟล์ และ view / SP / function / trigger ที่อ่าน definition ไม่ได้ฝั่งใดฝั่งหนึ่ง จะไม่ถูกเขียนทับหรือ DROP แม้ SET option, ชนิด หรือตารางของ trigger จะต่างกัน (มีแต่ comment)
- ในหน้า drift ไฟล์เดียวกันนี้คือ "script ย้อนกลับ": ทำให้ฝั่ง "ถึง" กลับไปเป็นแบบ "จาก"

### Rollback script

ทุกครั้งที่เปรียบเทียบจะได้ไฟล์ `.rollback.sql` คู่กับ `.sync.sql` ใช้ย้อนผลของ sync script: รันบนฝั่ง **target** หลังรัน sync script แล้ว schema จะกลับไปเป็นแบบตอนที่เปรียบเทียบ (สร้างจาก snapshot ของ target ก่อน sync)
- ใช้ได้ถูกต้องเมื่อหลังเปรียบเทียบ target ถูกแก้โดย sync script เท่านั้น ถ้ามีคนแก้อย่างอื่นด้วย ให้เปรียบเทียบใหม่
- object ที่ sync script **แก้** (column, index, check, FK, view, SP, function, trigger, synonym, sequence) ถูกแก้กลับเป็นแบบเดิม
- database trigger มาเป็น **ส่วนแรก** ของไฟล์: sync script จบด้วยการเปิด trigger ตามแบบ source ซึ่งตัวที่ปฏิเสธ DDL จะขวางทุกคำสั่งของ rollback ไฟล์จึงเริ่มด้วยการ `DISABLE` ตัวที่ sync script สร้างหรือแก้ รวมถึงตัวที่ไฟล์นี้จะ `ENABLE` กลับตอนท้าย (มี `IF EXISTS` กันกรณี trigger ไม่อยู่) จึงรันไฟล์นี้ซ้ำได้ แล้ว DROP ตัวที่สร้าง และแก้ตัวที่ถูกแก้กลับเป็นข้อความเดิม ส่วน `ENABLE` ตัวที่เปิดอยู่ก่อน sync เป็น **คำสั่งสุดท้ายของไฟล์** (หลังส่วน DROP ที่ comment ไว้ด้วย) เพราะตัวที่เปิดกลับเร็วเกินไปอาจเป็น trigger ของ target เองที่ปฏิเสธคำสั่งที่เหลือของ rollback เช่น trigger ที่ห้าม DROP index / procedure
  - ถ้า script หยุดกลางทาง trigger พวกนี้จะยังปิดอยู่: รันทั้งไฟล์ซ้ำ หรือรันส่วนสุดท้ายของไฟล์ (ใช้ได้เมื่ออ่าน target ได้ครบ ถ้า target ไม่มี `VIEW DEFINITION` ดูข้อของ database trigger ด้านล่าง)
- object ที่ sync script **สร้างใหม่**:
  - procedure / view / function / trigger / synonym / index / FK / check ถูก DROP จริงตั้งแต่ต้นไฟล์ ใช้ `DROP ... IF EXISTS` จึงรันได้แม้ sync script หยุดกลางทาง หรือรัน rollback ซ้ำ
  - table / column / sequence / type / schema ถูก **comment ไว้** ท้ายไฟล์ เพราะลบแล้วข้อมูลที่เขียนเข้ามาหลัง sync หายด้วย
  - constraint ที่ระบบตั้งชื่อเอง (ไม่มีชื่อใน source) ได้ชื่อใหม่ตอน sync จึงลบด้วยชื่อไม่ได้: ไฟล์จะมีหมายเหตุให้หาชื่อแล้วลบเอง
- object ที่มีแค่ฝั่ง target ไม่อยู่ใน rollback เพราะ sync script ไม่ได้ลบมัน (DROP ถูก comment ไว้) ถ้าไป uncomment แล้วรัน ต้องกู้จาก backup
- schema / type / sequence ที่ sync script สร้างให้ "เฉพาะเมื่อยังไม่มี" (กรณีไม่ได้เลือกหมวดนั้น) ไม่ถูกลบ
- มี `USE` + เช็คฐาน, `SET XACT_ABORT ON` และ transaction ของการ DROP แล้วสร้างใหม่ เหมือน sync script
- การ **แก้** ที่ sync script comment ไว้ (synonym ข้ามฐานที่เปลี่ยน, trigger คนละตาราง, object เปลี่ยนชนิด, computed column ฯลฯ) เป็น comment ในไฟล์นี้เช่นกัน ส่วน synonym ข้ามฐานที่เป็น **ของใหม่** (sync script comment คำสั่งสร้างไว้) ยังมี `DROP SYNONYM IF EXISTS` ที่รันจริงในไฟล์นี้: ถ้าไม่ได้ไปรันคำสั่งสร้างเอง คำสั่งนี้ไม่ทำอะไร
- ถ้า target ไม่มี `VIEW DEFINITION` การ DROP procedure / view / function / trigger / synonym จะถูก comment ไว้ท้ายไฟล์ เพราะบางตัวอาจมีอยู่ก่อน sync (ให้ uncomment เฉพาะตัวที่ sync script สร้างจริง)
  - database trigger: rollback แยกไม่ได้ว่าตัวไหน sync script สร้าง จึงไม่ DROP ให้ แต่ตัวที่เปิดอยู่ตอนเริ่มรันจะถูก `DISABLE` ชั่วคราว (จดไว้ในตารางชั่วคราว `#database_diff_disabled`) เพื่อไม่ให้ขวางคำสั่งของ rollback แล้ว `ENABLE` กลับเป็นคำสั่งสุดท้ายของไฟล์ ตัวที่มีอยู่ก่อน sync ก็ถูกปิดชั่วคราวแบบเดียวกัน และจบด้วยสถานะเดิม ทุกครั้งที่ปิด trigger script จะพิมพ์คำสั่งเปิดกลับไว้ในข้อความของการรัน พร้อมชื่อฐาน (`USE [ฐาน]; ENABLE TRIGGER ... ON DATABASE;`) **ถ้า script หยุดกลางทาง** trigger พวกนี้ (รวมตัวของ target เอง) จะยังปิดอยู่: รันทั้งไฟล์ซ้ำให้จบ แล้วรันคำสั่งที่พิมพ์ไว้ การรันซ้ำใน session อื่นเปิดกลับให้ไม่ได้ เพราะตารางชั่วคราวหายไปพร้อม session (มันจะพิมพ์ `WARNING` สำหรับ trigger ทุกตัวที่พบว่าปิดอยู่แทน ซึ่งรวมตัวที่ปิดอยู่เดิมตั้งแต่แรกด้วย เพราะ script แยกไม่ได้: ให้เปิดเฉพาะตัวที่การรันรอบที่หยุดไปพิมพ์ไว้) มีแต่การรันซ้ำในหน้าต่าง query เดิมที่เปิดกลับให้เอง
  - ถ้า uncomment บรรทัด `DROP TRIGGER ... ON DATABASE` ให้รันทั้งไฟล์: ตอนนั้น trigger ถูกปิดอยู่ จึงไม่ปฏิเสธการลบตัวเอง (ถ้ารันบรรทัดนั้นเดี่ยวๆ ต้อง `DISABLE` trigger เองก่อน)
- ข้อมูลที่หายไปแล้ว (เช่นจาก ALTER COLUMN ที่แคบลง) rollback กู้คืนไม่ได้ ต้องใช้ backup
- หน้า drift ไม่มีปุ่ม rollback เพราะ script ของหน้านั้นเป็น script ย้อนกลับอยู่แล้ว

### Script ทั้งหมดของ batch

การเปรียบเทียบหลายฐาน (batch) ในหน้าเว็บมีปุ่ม "Sync script ทั้งหมด" และ "Rollback script ทั้งหมด" รวม script ของทุกฐานไว้ในไฟล์เดียว เปิดใน SSMS ที่ต่อกับ server target แล้วรันทีเดียว (สร้างตอนกด จาก `.sync.sql` / `.rollback.sql` ของแต่ละฐาน จึงใช้กับ run เก่าได้ด้วย)
- ใส่เฉพาะฐานที่มีของต้องสร้างหรือแก้ ("ต้องเพิ่ม" หรือ "ต้องแก้") ฐานที่เหลือมีแต่ comment จึงไม่ได้ใส่ หัวไฟล์ลิสต์ไว้ทั้งฐานที่ไม่ได้ใส่และฐานที่ไม่มี script (เทียบไม่สำเร็จ)
- ก่อนแต่ละส่วนมี `USE` ของฐานนั้นแล้วเช็คว่าเข้าได้จริง ถ้าเข้าไม่ได้ (ต่อผิด server หรือไม่มีสิทธิ์) จะขึ้น error แล้วใช้ `SET NOEXEC ON` หยุดทั้งไฟล์ ส่วนที่เหลือไม่รันใส่ฐานผิดตัว ท้ายไฟล์มี `SET NOEXEC OFF` คืนค่า session
- error อื่นภายในส่วนของฐานหนึ่งไม่หยุดไฟล์ (เหมือนรันทีละไฟล์)

### เลือกรายการที่จะอยู่ใน script

ปกติ `.sync.sql` และ `.rollback.sql` รวมทุกความต่างของฐานไว้ในไฟล์เดียว ถ้าในฐานมีความต่างจากงานของหลายคน และต้องการ script เฉพาะของตัวเอง:

- ในหน้ารัน (ประวัติ) กดปุ่ม **"sync script เลือกเอง"** ของฐานนั้น (รันฐานเดียวคือ "Sync script เลือกเอง" ข้างบน) รายงานจะเปิดในโหมดเลือก
  - ในรายงานที่เปิดอยู่แล้วกด "เลือกรายการเพื่อสร้าง script" ที่แถบเครื่องมือก็ได้
- ทุกแถวความต่างมีช่องติ๊ก (ทุกหมวด: ตาราง คอลัมน์ index FK view SP function trigger ฯลฯ ทุกสถานะ) หัวการ์ดของตารางมี "เลือกทั้งตาราง" และแถบเครื่องมือมี "เลือกที่แสดงอยู่ทั้งหมด" (กรองชนิดหรือค้นชื่อก่อน แล้วเลือกทั้งหมดที่เหลือ) ที่ติ๊กไว้คงอยู่เมื่อเปลี่ยนตัวกรอง แต่หายเมื่อรีโหลดหน้า
- แถบด้านล่างมีปุ่มของ sync script และ rollback script อย่างละ 2 ปุ่ม: **"ดู"** เปิดแท็บใหม่ที่มี script ให้อ่านทันที มีปุ่ม "คัดลอก" (ไว้ไปวางใน SSMS เอง ข้อความที่คัดลอกไม่มี BOM) และ "ดาวน์โหลด" ในแท็บนั้น และ **"ดาวน์โหลด"** ได้ไฟล์ `<ฐาน>.selected.sync.sql` / `<ฐาน>.selected.rollback.sql` ที่มีเฉพาะแถวที่ติ๊กเลย
  - แท็บใหม่ถูกเปิดตอนกดปุ่ม (ก่อนสร้าง script) ถ้าเบราว์เซอร์บล็อก popup หน้ารายงานจะบอกให้อนุญาตแล้วกดอีกครั้ง
  - แท็บนั้นเก็บข้อความ script ไว้ในตัว ปิดหน้ารายงานแล้วยังคัดลอกและดาวน์โหลดได้
  - rollback ของชุดที่เลือกย้อนเฉพาะสิ่งที่ sync ของชุดเดียวกันทำ
  - ติ๊กครบทุกแถว ได้ไฟล์เหมือนที่การเปรียบเทียบเขียนไว้ทุกตัวอักษร (เทสต์ `engine-selected` ตรวจข้อนี้กับทุกเคสใน golden)
  - ถ้าเลือกไม่ครบ หัวไฟล์บอกว่า "Generated from a selection: K of N differences"
- ไฟล์สร้างจากผลเปรียบเทียบและ snapshot ที่รันนั้นเก็บไว้ (`<ฐาน>.json`, `<ฐาน>.source.snapshot.json`, `<ฐาน>.target.snapshot.json`) ไม่ต่อฐานข้อมูลอีก จึงใช้ได้กับรันเก่าในประวัติด้วย ถ้ารันนั้นไม่มีไฟล์เหล่านี้ ระบบบอกให้เทียบใหม่
- เช็คตัวที่พึ่งตัวอื่น **เฉพาะกรณีเดียว**: trigger หรือ foreign key ที่อ้างตารางซึ่งเป็นของใหม่ (ต้นแบบมี ปลายทางยังไม่มี) แต่ไม่ได้ติ๊กตารางนั้น หน้าจะบอกก่อนดาวน์โหลด (เลือกตารางให้ด้วย หรือดาวน์โหลดทั้งอย่างนั้น) และไฟล์ sync จะมี `WARNING:` ที่หัวไฟล์ ส่วนอย่างอื่น เช่น view หรือ procedure ที่อ้าง object ใหม่ที่ไม่ได้ติ๊ก ระบบตรวจไม่ได้ ต้องดูเองก่อนรัน
- ใช้ได้เมื่อเปิดรายงานจากในแอป (`/runs/<id>/<ไฟล์>.html`) เท่านั้น ไฟล์ `.html` ที่โหลดไปเปิดเองหรือรายงานของหน้า drift ไม่มีช่องติ๊ก
- รายงานของรันเก่าที่เปิดผ่านแอปจะแสดงด้วยเทมเพลตปัจจุบัน (ค่าของรายงานเป็นของเดิม) จึงมีช่องติ๊กด้วย ไฟล์ในโฟลเดอร์ของรันไม่ถูกแก้ และปุ่มดาวน์โหลดได้ไฟล์เดิม
- เลือกได้ทีละฐาน ปุ่ม "Sync script ทั้งหมด" ของ batch ยังรวมทุกความต่างของทุกฐานเหมือนเดิม

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
ใน batch ไฟล์ของแต่ละฐานใช้ชื่อฐานเป็นชื่อไฟล์ (ตัวอักษรที่ใช้ในชื่อไฟล์ไม่ได้ถูกแทนด้วย `_`) และเติมเลข (`-2`, `-3`) เฉพาะชื่อที่ไฟล์จะชนกัน: ฐานที่ได้ชื่อไฟล์เดียวกัน (`sales 2024` กับ `sales_2024`), ฐานชื่อ `index` หรือ `run` (ชนกับไฟล์ของ batch และของหน้าเว็บ), ฐานชื่อ `a.source.snapshot` เมื่อมีฐาน `a` อยู่ด้วย และชื่อที่ Windows สงวนไว้ (`nul`, `con`, `com1` ...)

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

- Column / Index / FK / Check เทียบเฉพาะตารางที่มีทั้งสองฝั่ง (ตารางที่ขาดรายงานครั้งเดียวในหมวด Table) index ของ view ก็เทียบเฉพาะ view ที่มีทั้งสองฝั่งเช่นกัน
- Constraint ที่ระบบตั้งชื่อเอง (`PK__Orders__3214EC07...`) จับคู่ด้วยตาราง + นิยาม ไม่ใช้ชื่อ ถ้านิยามตรงแต่ชื่อต่าง รายงานเป็น "ต่างกันแค่ชื่อ" (ใน `.json` คือ `Name: source a, target b`)
- Definition ถูก normalize ก่อนเทียบ: line ending, ช่องว่างท้ายบรรทัด, บรรทัดว่างหัวท้าย, `CREATE OR ALTER` นับเป็น `CREATE` (sync script ยังใช้ข้อความดิบ ไม่ตัดช่องว่างใน string literal)
- ชื่อ object ใน header ของ definition (และชื่อตารางหลัง `ON` ของ trigger) ไม่ถูกนำมาเทียบ เพราะ `sp_rename` ไม่แก้ข้อความที่เก็บไว้ สองฝั่งจับคู่กันด้วยชื่อใน catalog อยู่แล้ว (trigger ที่อยู่คนละตารางรายงานเป็น "อยู่บน: a → b" ใน `.json` คือ `Table: source a, target b`)
- ชื่อตารางและคอลัมน์จับคู่แบบไม่สนตัวพิมพ์ (ตรงกับ collation แบบ CI) ชื่อที่ต่างแค่ตัวพิมพ์ (`Id` กับ `id`) จึงไม่ถูกรายงาน และรายชื่อคอลัมน์ใน index / FK ก็เทียบแบบไม่สนตัวพิมพ์เช่นกัน
- ข้าม object ของ SSMS diagram: ดูจาก extended property `microsoft_database_tools_support` ที่ SSMS ใส่ไว้ (ปกติคือ `sysdiagrams`, `sp_*diagram*`, `fn_diagramobjects`) รวมถึงคอลัมน์และ index ของ `sysdiagrams` ด้วย

## รายงาน

รายงาน (`.html`) เป็นไฟล์เดียวจบ เปิดแบบ offline ได้ (ไม่โหลด font หรือ script จากที่อื่น) หัวรายงานบอกว่าฐานไหนเป็น **ต้นแบบ: ตัวที่ถูกต้อง (source)** และฐานไหนเป็น **ปลายทาง: ตัวที่จะถูกปรับ (target)** แล้วสรุปผลเป็น 4 กล่อง กดกล่องเพื่อกรองดูเฉพาะแบบนั้น

| ในรายงาน | ความหมาย | ใน `.json` |
|---|---|---|
| **+ ต้องเพิ่ม** (เขียว) | ต้นแบบมี แต่ปลายทางยังไม่มี sync จะสร้างให้ ยกเว้นส่วนที่ไฟล์ sync เขียนไว้เป็นหมายเหตุให้ทำเอง | `OnlyInSource` |
| **− มีเกิน** (แดง) | ปลายทางมีแต่ต้นแบบไม่มี sync ไม่ลบให้ แค่เขียนคำสั่งลบไว้เป็นหมายเหตุ | `OnlyInTarget` |
| **~ ต้องแก้** (เหลือง) | มีทั้งคู่แต่ไม่เหมือนกัน sync จะแก้ปลายทางให้ตรงต้นแบบ ยกเว้นส่วนที่ไฟล์ sync เขียนไว้เป็นหมายเหตุให้ทำเอง | `Different` |
| **? ตรวจไม่ได้** (เทา) | ค่าฝั่งใดฝั่งหนึ่งอ่านไม่ได้ (encrypted, CLR หรือไม่มีสิทธิ์) **ไม่นับเป็นผลต่าง** และไม่มีคำสั่งให้ | `Unverified` |

- รายงานของ drift (เทียบ snapshot เก่ากับตอนนี้) ใช้คำบอกเวลาแทน: **หายไป / เพิ่มขึ้นมา / ถูกแก้ / ตรวจไม่ได้** และสีสลับกัน (ของที่เคยมีแล้วหายไปเป็นสีแดง)
- เนื้อหาจัดตามตาราง: หนึ่งกล่องต่อหนึ่งตาราง รวมคอลัมน์ index foreign key check และ trigger ของตารางนั้น หัวกล่องบอกว่าเป็น "ตารางใหม่ทั้งตาราง" "ตารางเกินมาทั้งตาราง" หรือ "มีของข้างในต่างกัน"
- แต่ละรายการมีประโยคสั้นๆ ว่า sync จะทำอะไรกับมัน รายการที่ "ต้องแก้" แสดงค่าเป็น ~~ค่าของปลายทางตอนนี้~~ → ค่าของต้นแบบ ส่วนชื่อ property และค่าถูกแปลเป็นคำอ่านง่าย (เช่น `Nullable: source NULL, target NOT NULL` เป็น "ยอมให้ว่าง (NULL): ~~ไม่ได้ (NOT NULL)~~ → ได้ (NULL)")
  - ประโยคนี้พูดว่า "sync จะ..." เฉพาะเมื่อไฟล์ sync มีคำสั่งที่รันจริง ถ้าไฟล์ sync เขียนไว้แค่ comment จะบอกว่า "เขียนเป็นหมายเหตุให้ทำเอง" (เช่น synonym ข้ามฐาน, index แบบ columnstore, check ที่ไม่มีชื่อและของในตารางใหม่เมื่อ target ไม่มี `VIEW DEFINITION`) ส่วนกรณีที่รายงานรู้ไม่ได้จากข้อมูลของรายการนั้นเอง จะบอกเป็นเงื่อนไข เช่น คอลัมน์ที่ชนิดข้อมูลหรือ NULL ต่างกัน: "sync จะแก้... (ถ้าเป็นคอลัมน์คำนวณ หรือมีคอลัมน์คำนวณใช้คอลัมน์นี้ sync จะเขียนเป็นหมายเหตุให้ทำเองแทน)"
- ส่วนที่สอง "โค้ดและของอื่น": view, procedure, function, type, sequence, synonym, schema และ database trigger โดย index ของ view อยู่ใต้ view ของมัน
- ปุ่ม "ดูว่าโค้ดต่างกันตรงไหน" แสดง diff ทีละบรรทัด: แดง = บรรทัดในปลายทางตอนนี้ (จะหายไป) เขียว = บรรทัดจากต้นแบบ (จะใส่แทน)
- รายการที่ต่างกันแค่ `SetOptions` (เช่น `QUOTED_IDENTIFIER OFF` กับค่าปกติ) มีคำอธิบายใต้รายการ: โค้ดเหมือนกัน ต่างกันแค่ค่าที่ถูกบันทึกไว้ตอนสร้าง object
- มีช่องค้นชื่อ และตัวกรองตามชนิด (พร้อมจำนวน) ท้ายรายงานมี "ดูจำนวน object ที่อ่านได้ของแต่ละฝั่ง"
- `index.html` ของ batch และหน้าเว็บ (ประวัติ, หน้าผลการรัน, ตั้งเวลา) ใช้ 4 คำเดียวกัน

Exit code ของ command line: `0` = เหมือนกันและเทียบได้ครบ, `1` = มีผลต่าง หรือเทียบได้ไม่ครบ, `2` = error (รวมถึง batch ที่มีฐานเทียบไม่สำเร็จอย่างน้อยหนึ่งฐาน และกรณี instance ที่ตอบไม่ตรงกับชื่อใน address)

## สำคัญ: สิทธิ์ VIEW DEFINITION

Login ทั้งสองฝั่งควรมี `VIEW DEFINITION` ในฐานที่เทียบ (หรือ `VIEW ANY DEFINITION` ระดับเซิร์ฟเวอร์) ถ้าไม่มี SQL Server จะ
1. ซ่อน object ที่ login ไม่มีสิทธิ์อื่นเลย ทำให้ขึ้นเป็น "ต้องเพิ่ม" หรือ "มีเกิน" ทั้งที่จริงมีอยู่
2. คืน definition ของ view / SP / default / check เป็น NULL ทำให้ขึ้นเป็น "ตรวจไม่ได้"
3. ซ่อนชื่อของ user-defined type ที่ login ไม่มีสิทธิ์: column ที่ใช้ type นั้นยังเห็นอยู่ แต่ชนิดขึ้นเป็น "อ่านไม่ได้" (ไม่นับเป็นผลต่าง)

ระบบตรวจสิทธิ์ให้อัตโนมัติ และขึ้นเตือนในหน้าเว็บ รายงาน และหัว sync script เมื่อฝั่ง target เป็นแบบนี้ sync / rollback script จะไม่เขียนทับ ไม่เพิ่มของลงใน และไม่ลบ object ที่อาจมีอยู่แล้วแต่มองไม่เห็น (ดูหัวข้อ Sync script และ Rollback script)

## Test

```powershell
npm install
npm run typecheck
npm test                     # ราว 1-2 นาที
npm run test:update-golden   # เขียน golden ใหม่จากผลปัจจุบัน
```

- test สร้างฐานทดสอบชื่อ `ddtest_*` ใน LocalDB (`(localdb)\MSSQLLocalDB`) แล้วรัน engine จริง จะลบและสร้างใหม่เฉพาะฐานที่ชื่อขึ้นต้นด้วย `ddtest_` เท่านั้น
- ใช้ server อื่นได้ด้วย `DATABASE_DIFF_TEST_SERVER` (ต้องเป็น Windows auth และเป็นเครื่องทดสอบ เพราะ test รัน sync/rollback script จริง)
- ถ้าต่อ server ไม่ได้ test ที่ใช้ฐานจะถูก skip ถ้าตั้ง `DATABASE_DIFF_REQUIRE_DB=1` (สำหรับ CI) จะ fail แทน
- fixture อยู่ใน `test\fixtures\<ชุด>\`: `common.sql` รันทั้งสองฝั่ง แล้ว `source.sql` / `target.sql` รันเฉพาะฝั่งนั้น เคสทั้งหมดอยู่ใน `test\cases.ts`
- golden (`test\golden\<เคส>\`) คือผลของ engine (JSON, sync script, rollback script, snapshot) โดยแทนค่าที่เปลี่ยนทุกครั้งด้วย placeholder (เวลา, ชื่อ server, login, ชื่อ constraint ที่ระบบสุ่ม) ถ้าตั้งใจเปลี่ยนผลของ engine ให้รัน `test:update-golden` แล้ว **อ่าน git diff ของ golden ก่อน commit**
- เคส round-trip (`core`, `core-ignore-collation`, `core-default` ซึ่งใช้หมวด default) รัน sync script บน target แล้วเทียบใหม่ จากนั้นรัน rollback script (สองรอบ) แล้วเทียบกับ snapshot เดิม และเช็คว่าข้อมูลยังอยู่ ส่วนเคส `edge` (ผลต่างที่ script แก้ให้ไม่ได้) รัน script ทั้งสองแล้วเก็บผลที่เหลือไว้ใน golden
- ไฟล์ test:

  | ไฟล์ | ทดสอบอะไร |
  |---|---|
  | `engine.test.ts` | golden + round-trip ของเคสใน `cases.ts` |
  | `engine-safety.test.ts` | การแก้ที่ทำไม่ได้ (ข้อมูลไม่ผ่าน constraint, index ที่เขียนแทนไม่ได้) ต้องไม่ทำให้ของเดิมหาย |
  | `engine-computed.test.ts` | column ที่ computed column ใช้อยู่: script ต้องรันผ่านทุก batch และบรรทัดที่ comment ไว้ให้รันเองต้องรันได้จริง |
  | `engine-ddlguard.test.ts` | database trigger ที่ปฏิเสธ DDL (`RAISERROR` + `ROLLBACK`): sync script ต้องรันผ่านทุก batch โดยไม่มี error และ rollback script ต้องรันผ่านตั้งแต่รอบแรก แล้วได้ target กลับเป็นแบบเดิม ทั้งสอง script รันซ้ำได้ (หลังรันจบ หรือหลังหยุดกลางทาง) โดยไม่ถูก trigger ของรอบก่อนปฏิเสธ (รวม trigger ของ target เองที่ห้าม DROP) sync ที่หยุดหลังปิด trigger ไปแล้ว (รันด้วย `-b` แล้วเจอ error) ต้องพิมพ์คำสั่งเปิดกลับของทุกตัวที่มันปิด ซึ่งรันตามที่พิมพ์ใน session ใหม่แล้วได้สถานะเดิม และกรณี target ไม่มี `VIEW DEFINITION`: trigger ที่ script สร้างเองต้องไม่ขวาง script ส่วนตัวที่ซ่อนอยู่ต้องไม่ถูกแตะ และ script ที่หยุดกลางทาง (หรือ sync ที่รันด้วย `-b`) ต้องพิมพ์คำสั่งเปิด trigger กลับ และเตือนเมื่อรันซ้ำใน session อื่น |
  | `engine-incomplete.test.ts` | target ที่ไม่มี `VIEW DEFINITION`: ไม่เขียนทับ ไม่เพิ่ม ไม่ลบของที่มองไม่เห็น |
  | `engine-restricted.test.ts` | กรณีเดียวกันด้วย SQL login จริงที่ไม่มี `VIEW DEFINITION`: test สร้าง login `ddtest_restricted_login` บน server ทดสอบ (รหัสผ่านสุ่มทุกรอบ) แล้วลบทิ้งเมื่อจบ |
  | `engine-script.test.ts` | ข้อความใน script จาก snapshot ที่เขียนขึ้นเอง (ไม่ใช้ฐาน): collation ของ user-defined type, computed column, default, type / sequence ที่ต้องใช้, synonym ข้ามฐาน ฯลฯ |
  | `engine-functions.test.ts` | function เดี่ยวของ engine ผ่าน `test\support\Invoke-EngineFunction.ps1` (ไม่ใช้ฐาน) |
  | `engine-compat.test.ts` | snapshot รูปแบบเก่ายังเทียบได้ |
  | `engine-cli.test.ts` | พฤติกรรมของ command line (batch, `-ListDatabases`, ชื่อ server ที่ตอบ) |
  | `report.test.ts` | รายงาน HTML และ `index.html` ของ batch โดยไม่ใช้ browser: ดึง script ออกจากไฟล์ HTML มารันตรงๆ ทดสอบคำที่ใช้, การอ่าน detail ของ engine, การจัดกลุ่มตามตาราง และ diff ของโค้ด ทั้งจากข้อมูลที่เขียนเองและจากรายงานจริงของ fixture (`core`, `edge`, ผลไม่ครบ, drift, batch) |
  | `app.test.ts` | module ของหน้าเว็บ, `cli.js` และ server จริงบน port ว่าง โดยใช้ data folder ชั่วคราว (ตั้งผ่าน `DATABASE_DIFF_DATA` และ `DATABASE_DIFF_MCP_PROFILES` จึงไม่แตะ `data\` และ profile จริง) |
  | `retention.test.ts` | การลบประวัติเก่าอัตโนมัติ และการลบ run จากหน้าประวัติ (ไฟล์ถูกใช้อยู่, ไฟล์ที่ server กำลังส่งเอง, ลบไฟล์ไม่หมด, error อื่น) ทุกเคสใช้ data folder ของตัวเองใน `test\.out\retention-*` |
  | `golden.test.ts` | การแทนค่าที่เปลี่ยนทุกครั้งใน golden (ชื่อ server ที่ตอบ) |
  | `ps-ascii.test.ts` | ไฟล์ `.ps1` ต้องเป็น ASCII ล้วน และไฟล์ `.js` / `.ts` ต้องไม่มี BOM หรือ U+2028 / U+2029 ที่มองไม่เห็น |
- test ที่มีป้าย `todo` คือ bug ที่รู้แล้วแต่ยังไม่แก้ ไม่ทำให้ชุด test fail
- ผลของแต่ละรอบอยู่ใน `test\.out\` (ไม่เข้า git) ไว้เปิดดูเมื่อ test fail

## ไฟล์ในโปรเจกต์

| path | คือ |
|---|---|
| `Compare-Database.ps1` | engine (อ่าน schema, เทียบ, เขียนรายงาน) |
| `lib\SyncScript.ps1` | สร้าง sync script และ rollback script |
| `lib\SelectedScript.ps1` | สร้าง sync/rollback script ของแถวที่เลือก จากผลและ snapshot ที่รันเก็บไว้ (`-ScriptFromResult`) |
| `templates\` | template ของรายงาน HTML (`report.html`) และหน้าสรุปของ batch (`index.html`): ข้อความภาษาไทยของรายงานอยู่ที่นี่ engine ใส่ข้อมูลเป็น JSON ให้ |
| `app\` | หน้าเว็บ (Node, ไม่มี dependency) และ `cli.js` / `run-job.ps1` สำหรับงานตั้งเวลา |
| `test\` | test ของ engine และหน้าเว็บ (TypeScript, `node:test`): fixture, golden, helper |
| `scripts\` | script สำหรับพัฒนา (`update-golden.ts`) |
| `data\` | ประวัติการรัน, snapshot, profile ของ server, งานตั้งเวลา, `retention.log` (ไม่เข้า git) |
| `reports\` | ผลของการรันจาก command line (ไม่เข้า git) |
