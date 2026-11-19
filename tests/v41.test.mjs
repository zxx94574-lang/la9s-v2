// 0072: 打卡一个按键 (450) — 按今天的状态走; 没上班卡不能下班; 提前下班要原因, 记早退算异常
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';

test('打卡: 第一下 = 上班, 第二下 = 下班, 第三下不让打; 提前下班必须写原因并记早退', async () => {
  const t = await setup();
  const P = `select app.punch($1,5.3501,-4.0101,20,$2)`;
  let s = await t.val(U.picker, `select app.punch_state($1)`, [t.ids.org]);
  assert.equal(s.next, 'in');
  let r = await t.val(U.picker, P, [t.ids.org, null]);
  assert.equal(r.kind, 'in');
  // 下班时间设到 23:59 → 现在打一定算提前
  await t.db.query(`update app.attendance_settings set end_time = '23:59:59', half_day_end = '23:59:59' where org_id = $1`, [t.ids.org]);
  await t.db.query(`update app.employees set work_schedule = '{"0":"full","6":"full"}' where org_id = $1`, [t.ids.org]);
  s = await t.val(U.picker, `select app.punch_state($1)`, [t.ids.org]);
  assert.equal(s.next, 'out'); assert.equal(s.early, true);
  await assert.rejects(t.val(U.picker, P, [t.ids.org, null]), /EARLY_NOTE/);
  await assert.rejects(t.val(U.picker, P, [t.ids.org, '  ']), /EARLY_NOTE/);
  r = await t.val(U.picker, P, [t.ids.org, '去医院']);
  assert.equal(r.kind, 'out'); assert.equal(r.early, true);
  const row = await t.one(`select early, early_note from app.attendance where kind = 'out' order by at desc limit 1`);
  assert.equal(row.early, true); assert.equal(row.early_note, '去医院');
  await assert.rejects(t.val(U.picker, P, [t.ids.org, 'x']), /都打过卡了/);
  s = await t.val(U.picker, `select app.punch_state($1)`, [t.ids.org]);
  assert.equal(s.next, 'done');
});

test('打卡: 到点下班不用写原因, 不算早退', async () => {
  const t = await setup();
  const P = `select app.punch($1,5.3501,-4.0101,20,$2)`;
  await t.db.query(`insert into app.attendance_settings (org_id) values ($1) on conflict do nothing`, [t.ids.org]);
  await t.db.query(`update app.attendance_settings set end_time = '00:00', half_day_end = '00:00' where org_id = $1`, [t.ids.org]);
  await t.val(U.manager, P, [t.ids.org, null]);
  const r = await t.val(U.manager, P, [t.ids.org, null]);
  assert.equal(r.kind, 'out'); assert.equal(r.early, false);
});
