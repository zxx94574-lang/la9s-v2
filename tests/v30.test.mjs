// 0060: 工号 = 登录账号 —— 有工号自动有账号位置, 默认锁住; 密码中方手动设; 设了才能解锁; 离职自动锁
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });

test('工号 = 账号: 自动建位置且锁住; 设密码 → 解锁 → 登录; 改工号登录名跟着变; 停用自动锁; 密码读不到', async () => {
  const t = await setup();
  const emp = (await t.one(`insert into app.employees (org_id, short_name, emp_no) values ($1,'NEWGUY','s901') returning id`, [t.ids.org])).id;
  let a = await t.one(`select * from app.staff_accounts where employee_id = $1`, [emp]);
  assert.equal(a.login, 'S901'); assert.equal(a.locked, true); assert.equal(a.pass_hash, null);
  await rejects(t.as(U.admin, `select app.set_staff_lock($1,false)`, [emp]), /先设密码/);
  await rejects(t.as(U.manager, `select app.set_staff_password($1,'abc12345')`, [emp]), /PERMISSION/);
  await rejects(t.as(U.admin, `select app.set_staff_password($1,'123')`, [emp]), /至少 6 位/);
  await t.as(U.admin, `select app.set_staff_password($1,'abc12345')`, [emp]);
  a = await t.one(`select * from app.staff_accounts where employee_id = $1`, [emp]);
  assert.ok(a.pass_hash && a.pass_hash !== 'abc12345', '存的是加密后的'); assert.equal(a.locked, true, '设了密码仍然锁着，要中方手动解锁');
  await rejects(t.as(U.admin, `select app.staff_login($1,'S901','abc12345')`, [t.ids.org]), /还没开通/);
  await t.as(U.admin, `select app.set_staff_lock($1,false)`, [emp]);
  const r = await t.val(U.admin, `select app.staff_login($1,'s901','abc12345')`, [t.ids.org]);
  assert.equal(r.employee_id, emp);
  await rejects(t.as(U.admin, `select app.staff_login($1,'S901','wrong')`, [t.ids.org]), /不对/);
  const v = await t.as(U.admin, `select * from app.v_staff_accounts where employee_id = $1`, [emp]);
  assert.equal(v[0].has_password, true); assert.ok(!('pass_hash' in v[0]));
  assert.equal((await t.as(U.manager, `select * from app.v_staff_accounts`)).length, 0, '员工看不到账号表');
  await t.db.query(`update app.employees set emp_no = 'S902' where id = $1`, [emp]);
  assert.equal((await t.one(`select login from app.staff_accounts where employee_id = $1`, [emp])).login, 'S902');
  await t.db.query(`update app.employees set active = false where id = $1`, [emp]);
  assert.equal((await t.one(`select locked from app.staff_accounts where employee_id = $1`, [emp])).locked, true);
  await rejects(t.as(U.admin, `select app.set_staff_lock($1,false)`, [emp]), /停用/);
});
