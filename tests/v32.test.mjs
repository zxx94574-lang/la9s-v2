// 0062: 选项不写死 —— 确认方式放开; 自己加的发货方式 / 退货类型名字另存; 签收确认人身份放开、电话选填
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';
const rejects = (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });

test('确认方式: ⚙ 里新加的名字后台认; 不选照样拦; 老的三个值照常', async () => {
  const t = await setup();
  const left = (await t.db.query(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.prosrc ~ $re$not in \\('whatsapp',\\s*'phone',\\s*'in_store'\\)$re$`)).rows;
  assert.equal(left.length, 0, '所有写死确认方式的函数都放开了: ' + left.map((r) => r.proname).join(','));
  const L = JSON.stringify([{ product_id: t.ids.bg6mCover, qty_req: 5 }]);
  const d = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [t.ids.org, t.ids.camaraAbobo, L]);
  await t.as(U.hotline, `select app.quote_confirm($1,'ok','Telegram',null,null,false)`, [d]);
  const row = await t.one(`select * from app.deals where id = $1`, [d]);
  assert.equal(row.status, 'hotline_ok');
});

test('签收: 电话可以不填、身份可以是「销售员」; 自己加的发货方式名字另存', async () => {
  const t = await setup();
  const d = await t.toConfirmed(t.ids.camaraAbobo, [{ product_id: t.ids.bg6mCover, qty_req: 2 }]); await t.shipAll(d);
  const sh = await t.val(U.admin, `select id from app.shipments where deal_id = $1 limit 1`, [d]);
  await t.as(U.hotline, `select app.sign_receipt($1,'s.jpg',now(),'Koffi','','sales')`, [sh]);
  const s = await t.one(`select confirm_name, confirm_phone, confirm_role from app.shipments where id = $1`, [sh]);
  assert.equal(s.confirm_role, 'sales'); assert.equal(s.confirm_phone, null);
  assert.equal((await t.one(`select contacts from app.customers where id = $1`, [t.ids.camaraAbobo])).contacts.length, 0);
  await t.as(U.manager, `select app.set_opt_label('ship_method', $1, '三轮车')`, [sh]);
  assert.equal((await t.one(`select method_label from app.shipments where id = $1`, [sh])).method_label, '三轮车');
  await rejects(t.as(U.outsider, `select app.set_opt_label('ship_method', $1, 'x')`, [sh]), /PERMISSION/);
});
