// 0017: 客户账号 (只存加密密码、中方开通 / 重置 / 冻结、验证码改密码通知中方) + 游客询价 (选销售员、自动建潜客、进已报价)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';

const rejects = async (p, re) => { try { await p; } catch (e) { assert.match(e.message, re); return; } assert.fail('should have thrown'); };

test('客户账号: 中方开通得临时密码, 库里只有加密值; 登录 / 冻结 / 重置 / 验证码改密码', async () => {
  const t = await setup();
  const c = t.ids.camaraAbobo;
  await t.as(U.admin, `update app.customers set phone = '07 07 11 22 33' where id = $1`, [c]);
  await rejects(t.as(U.manager, `select app.account_open($1)`, [c]), /PERMISSION_DENIED/);
  const pw = await t.val(U.admin, `select app.account_open($1)`, [c]);
  assert.equal(pw.length, 8);
  const a = await t.one(`select * from app.customer_accounts where customer_id = $1`, [c]);
  assert.equal(a.login, '0707112233', '账号默认 = 手机号数字');
  assert.notEqual(a.pass_hash, pw); assert.ok(a.pass_hash.startsWith('$2'), '只存 bcrypt');
  await rejects(t.val(U.admin, `select app.account_open($1)`, [c]), /已经有账号/);
  await rejects(t.val(null, `select app.account_login('0707112233','wrong')`), /账号或密码不对/);
  const s = await t.val(null, `select app.account_login('07 07 11 22 33',$1)`, [pw]);
  assert.equal(s.customer_id, c); assert.equal(s.must_change, true);
  // 登录后就是这个客户的老板身份 (客户下单端)
  const me = (await t.as(s.user_id, `select * from app.portal_me()`))[0];
  assert.equal(me.customer_id, c); assert.equal(me.role, 'boss');
  // 冻结: 登不上, 已登录的身份也失效
  await t.as(U.admin, `select app.account_set_status($1,'frozen','不是本人改的密码')`, [a.id]);
  await rejects(t.val(null, `select app.account_login('0707112233',$1)`, [pw]), /冻结/);
  assert.equal((await t.as(s.user_id, `select * from app.portal_me()`)).length, 0);
  await t.as(U.admin, `select app.account_set_status($1,'active')`, [a.id]);
  // 重置: 旧密码失效
  const pw2 = await t.val(U.admin, `select app.account_reset($1)`, [a.id]);
  await rejects(t.val(null, `select app.account_login('0707112233',$1)`, [pw]), /不对/);
  await t.val(null, `select app.account_login('0707112233',$1)`, [pw2]);
  // 客户自己改密码: 验证码 → 自动生效 → 中方有通知
  const code = await t.val(null, `select app.account_send_otp('0707112233')`);
  await rejects(t.as(null, `select app.account_change_password('0707112233','000000x','newpass1')`), /验证码不对/);
  await t.as(null, `select app.account_change_password('0707112233',$1,'newpass1')`, [code]);
  const s2 = await t.val(null, `select app.account_login('0707112233','newpass1')`);
  assert.equal(s2.must_change, false);
  const ev = await t.one(`select * from app.account_events where account_id = $1 and kind = 'pw_changed'`, [a.id]);
  assert.equal(ev.acked_at, null);
  await t.as(U.admin, `select app.account_ack($1)`, [ev.id]);
  // 换账号只能中方
  await t.as(U.admin, `select app.account_set_login($1,'C001')`, [a.id]);
  await t.val(null, `select app.account_login('c001','newpass1')`);
});

test('游客询价: 选销售员 → 新电话自动建潜客挂销售员 → 已报价单; 老电话挂老客户; 必填和防刷', async () => {
  const t = await setup();
  await t.as(U.admin, `select app.upsert_employee($1,$2,$3)`, [t.ids.org, t.ids.sales, JSON.stringify({ short_name: 'Koffi', full_name: 'Koffi Demo', emp_no: 's01', sys_role: 'sales' })]);
  await rejects(t.as(U.admin, `select app.upsert_employee($1,$2,$3)`, [t.ids.org, t.ids.picker, JSON.stringify({ short_name: 'Abowa', emp_no: 'S01' })]), /员工编号/);
  const sales = await t.as(null, `select * from app.guest_sales($1)`, [t.ids.org]);
  assert.deepEqual(sales.map((s) => s.emp_no), ['S01']);
  const cat = await t.as(null, `select * from app.guest_catalog($1)`, [t.ids.org]);
  assert.ok(cat.length > 0 && !('price' in cat[0]) && ['ok', 'low', 'none'].includes(cat[0].band), '游客只看有没有货');
  const info = { phone: '+225 05 99 88 77 66', shop: 'Boutique Test', city: 'Yopougon', contact: 'Awa', sales_id: t.ids.sales };
  await rejects(t.as(null, `select app.guest_inquiry($1,$2,$3)`, [t.ids.org, JSON.stringify({ ...info, shop: '' }), JSON.stringify([{ product_id: t.ids.bg6mCover, qty: 5 }])]), /店名/);
  const no = await t.val(null, `select app.guest_inquiry($1,$2,$3,'先问问')`, [t.ids.org, JSON.stringify(info),
    JSON.stringify([{ product_id: t.ids.bg6mCover, qty: 5 }, { model: 'spark 99', category_id: t.ids.catScreen, qty: 3 }])]);
  const d = await t.one(`select d.*, c.status as cstatus, c.owner_employee_id as cowner, c.temp_code from app.deals d join app.customers c on c.id = d.customer_id where d.biz_no = $1`, [no]);
  assert.equal(d.source, 'guest'); assert.equal(d.status, 'quoted'); assert.equal(d.cstatus, 'prospect'); assert.ok(d.temp_code);
  assert.equal(d.cowner, t.ids.sales, '潜客挂选的销售员'); assert.equal(d.owner_employee_id, t.ids.sales);
  assert.equal(d.approval, 'pending', '新客户要中方审批');
  const lines = await t.as(U.admin, `select * from app.deal_lines where deal_id = $1 order by seq`, [d.id]);
  assert.equal(lines.length, 2); assert.equal(lines[1].req_model, 'SPARK 99');
  // 同一个电话再问: 挂同一个潜客
  const no2 = await t.val(null, `select app.guest_inquiry($1,$2,$3)`, [t.ids.org, JSON.stringify(info), JSON.stringify([{ product_id: t.ids.bg6mCover, qty: 1 }])]);
  assert.equal((await t.one(`select customer_id from app.deals where biz_no = $1`, [no2])).customer_id, d.customer_id);
  await t.val(null, `select app.guest_inquiry($1,$2,$3)`, [t.ids.org, JSON.stringify(info), JSON.stringify([{ product_id: t.ids.bg6mCover, qty: 1 }])]);
  await rejects(t.val(null, `select app.guest_inquiry($1,$2,$3)`, [t.ids.org, JSON.stringify(info), JSON.stringify([{ product_id: t.ids.bg6mCover, qty: 1 }])]), /太频繁/);
});
