// 0088: 指令一键去做 —— 批量客户逐个提交 / 催款客户说哪天付、过期自动紧急
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, U } from './harness.mjs';

test('批量指令: 每位客户一项, 逐个交完整条才算交; 催款: 客户说哪天付, 过期变紧急', async () => {
  const t = await setup();
  const hot = (await t.one(`insert into app.employees (org_id, short_name, active) values ($1,'热线员',true) returning id`, [t.ids.org])).id;
  await t.db.query(`update app.members set employee_id = $1 where user_id = $2`, [hot, U.hotline]);
  await t.val(U.admin, `select app.issue_directive4($1,$2)`, [t.ids.org, JSON.stringify({ title: '回访没下单的客户', assignees: [hot], dir_type: '回电话', customers: [t.ids.camaraAbobo, t.ids.camaraOme] })]);
  const d = await t.one(`select id, batch, ref_label from app.directives where title = '回访没下单的客户'`);
  assert.equal(d.batch, true); assert.equal(d.ref_label, '2 位客户');
  const items = (await t.db.query(`select id, customer_id from app.directive_items where directive_id = $1 order by customer_id = $2 desc`, [d.id, t.ids.camaraAbobo])).rows;
  assert.equal(items.length, 2);
  await assert.rejects(t.as(U.hotline, `select app.directive_item_done($1,null,null,'')`, [items[0].id]), /写一句结果/);
  await t.as(U.hotline, `select app.directive_item_done($1,null,null,'缺货，等到货')`, [items[0].id]);
  assert.equal((await t.one(`select status from app.directives where id = $1`, [d.id])).status, 'acked');
  await t.as(U.hotline, `select app.directive_item_done($1,null,null,'这周下单')`, [items[1].id]);
  assert.equal((await t.one(`select status from app.directives where id = $1`, [d.id])).status, 'done');
  await assert.rejects(t.as(U.manager, `select app.directive_item_done($1,null,null,'x')`, [items[1].id]), /PERMISSION|交过/);

  // 催款
  await t.val(U.admin, `select app.issue_directive3($1,$2)`, [t.ids.org, JSON.stringify({ title: '催 CAMARA 欠款', assignees: [hot], dir_type: '催款', customer_id: t.ids.camaraAbobo })]);
  const c = await t.one(`select id from app.directives where title = '催 CAMARA 欠款'`);
  await assert.rejects(t.as(U.hotline, `select app.directive_promise($1,null,'2020-01-01','x')`, [c.id]), /今天或以后/);
  await t.as(U.hotline, `select app.directive_promise($1,null,current_date + 3,'客户说周五')`, [c.id]);
  let r = await t.one(`select status, promise_on is not null as p, urgent from app.directives where id = $1`, [c.id]);
  assert.equal(r.status, 'acked'); assert.ok(r.p); assert.equal(r.urgent, false);
  await t.db.query(`update app.directives set promise_on = current_date - 1 where id = $1`, [c.id]);
  // 批量里的催款项过期: 回到 todo, 整条回到员工手里
  await t.val(U.admin, `select app.issue_directive4($1,$2)`, [t.ids.org, JSON.stringify({ title: '批量催款', assignees: [hot], dir_type: '催款', customers: [t.ids.camaraOme] })]);
  const b = await t.one(`select id from app.directives where title = '批量催款'`);
  const bi = await t.one(`select id from app.directive_items where directive_id = $1`, [b.id]);
  await t.as(U.hotline, `select app.directive_promise($1,$2,current_date,'今天付')`, [b.id, bi.id]);
  assert.equal((await t.one(`select status from app.directives where id = $1`, [b.id])).status, 'done');
  await t.db.query(`update app.directive_items set promise_on = current_date - 1 where id = $1`, [bi.id]);
  await t.as(U.admin, `select app.directive_sweep($1)`, [t.ids.org]);
  r = await t.one(`select urgent from app.directives where id = $1`, [c.id]); assert.equal(r.urgent, true);
  r = await t.one(`select d.status, d.urgent, i.status as ist from app.directives d join app.directive_items i on i.directive_id = d.id where d.id = $1`, [b.id]);
  assert.equal(r.status, 'acked'); assert.equal(r.urgent, true); assert.equal(r.ist, 'todo');
});

test('去做 → 提交指令: candidates2 找到指令下达后这位客户的新单, 直接交', async () => {
  const t = await setup();
  const hot = (await t.one(`insert into app.employees (org_id, short_name, active) values ($1,'热线员',true) returning id`, [t.ids.org])).id;
  await t.db.query(`update app.members set employee_id = $1 where user_id = $2`, [hot, U.hotline]);
  await t.val(U.admin, `select app.issue_directive3($1,$2)`, [t.ids.org, JSON.stringify({ title: '制单 X', assignees: [hot], dir_type: '制单', customer_id: t.ids.camaraAbobo })]);
  const d = await t.one(`select id from app.directives where title = '制单 X'`);
  assert.equal((await t.as(U.hotline, `select * from app.directive_candidates2($1,$2)`, [d.id, t.ids.camaraAbobo])).length, 0);
  const deal = await t.val(U.manager, `select app.create_quote($1,$2,'XOF',$3)`, [t.ids.org, t.ids.camaraAbobo, JSON.stringify([{ product_id: t.ids.bg6mScreen, qty_req: 5 }])]);
  const c = await t.as(U.hotline, `select * from app.directive_candidates2($1,$2)`, [d.id, t.ids.camaraAbobo]);
  assert.equal(c[0].id, deal);
  await t.as(U.hotline, `select app.complete_directive2($1,null,null,$2,$3)`, [d.id, c[0].kind, c[0].id]);
  assert.equal((await t.one(`select status from app.directives where id = $1`, [d.id])).status, 'done');
});
