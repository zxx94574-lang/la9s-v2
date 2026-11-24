// 0086: 请假 + 迟到报备 → 出勤天数
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';

test('请假不算出勤; 报备的迟到前 N 次不扣, 没报备的扣当天', async () => {
  const t = await setup();
  const emp = t.ids.sales; await t.db.query(`update app.members set employee_id = $1 where user_id = $2 and org_id = $3`, [emp, U.picker, t.ids.org]);
  await t.db.query(`insert into app.attendance_settings (org_id) values ($1) on conflict do nothing`, [t.ids.org]);
  const punch = (day, hm, late) => t.db.query(`insert into app.attendance (org_id, employee_id, user_id, kind, at, ok, late) values ($1,$2,$3,'in',$4,true,$5)`, [t.ids.org, emp, U.picker, `${day}T${hm}:00Z`, late]);
  const wd = async () => Number((await t.db.query(`select app.worked_days($1,$2,'2026-10-01') as n`, [t.ids.org, emp])).rows[0].n);
  await punch('2026-10-05', '08:00', false); await punch('2026-10-06', '08:00', false);
  assert.equal(await wd(), 2);
  // 没报备的迟到: 扣当天
  await punch('2026-10-07', '09:00', true);
  assert.equal(await wd(), 2);
  // 报备了: 这个月前 2 次不扣
  await t.db.query(`insert into app.late_reports (org_id, employee_id, day, reason) values ($1,$2,'2026-10-07','堵车')`, [t.ids.org, emp]);
  assert.equal(await wd(), 3);
  for (const d of ['2026-10-08', '2026-10-09']) { await punch(d, '09:00', true); await t.db.query(`insert into app.late_reports (org_id, employee_id, day, reason) values ($1,$2,$3,'堵车')`, [t.ids.org, emp, d]); }
  assert.equal(await wd(), 4, '第 3 次报备的迟到照扣');
  // 请假: 半天打了卡算 0.5; 全天没打卡算 0, 也不算没打卡
  await t.db.query(`insert into app.leaves (org_id, employee_id, day, kind) values ($1,$2,'2026-10-06','am'), ($1,$2,'2026-10-12','full')`, [t.ids.org, emp]);
  assert.equal(await wd(), 3.5);
  // 自己填请假 (周日跳过)
  const n = await t.val(U.picker, `select app.take_leave($1,$2)`, [t.ids.org, JSON.stringify({ from: '2026-12-05', to: '2026-12-07', kind: 'full', reason: '家里有事' })]);
  assert.equal(Number(n), 2);
  await assert.rejects(t.as(U.picker, `select app.take_leave($1,$2)`, [t.ids.org, JSON.stringify({ from: '2026-12-08', kind: 'hours' })]), /几点到几点/);
  await t.as(U.picker, `select app.take_leave($1,$2)`, [t.ids.org, JSON.stringify({ from: '2026-12-08', kind: 'hours', from_time: '10:00', to_time: '12:00' })]);
  assert.equal(Number((await t.one(`select hours from app.leaves where day = '2026-12-08'`)).hours), 2);
  await t.as(U.admin, `select * from app.attendance_anomalies($1,'2026-10-01','2026-10-31')`, [t.ids.org]);
});
