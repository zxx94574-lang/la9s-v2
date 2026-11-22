// 测试版数据 (VITE_TEST=1, 11-22 Frank 要求): 在 10-19 真实快照上, 全部通过真实业务函数、按岗位身份生成各种场景,
// 每种情况留十几二十条, 给 Frank 一条条点开看. 只用于测试版 artifact, 绝不进真实版.
// node 里同一套可以跑 (scripts/test-seed), 每个场景出错都记下来 = 要修的问题.
import { USERS, asUser } from './bootstrap.js';

export async function seedScenarios(db, org, log = () => {}) {
  const as = (u, sql, p = []) => asUser(db, u, sql, p);
  const val = async (u, sql, p) => Object.values((await as(u, sql, p))[0] || {})[0];
  const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
  const all = async (sql, p = []) => (await db.query(sql, p)).rows;
  const report = { ok: {}, fail: [] };
  const run = async (name, fn) => {
    try { await fn(); report.ok[name] = (report.ok[name] || 0) + 1; }
    catch (e) { report.fail.push({ name, err: String(e.message || e).slice(0, 300) }); }
  };
  const photo = (k) => `test://${k}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  const day = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

  // ── 准备: 关掉影响「造历史数据」的规则, 结束后恢复 ──
  await db.query(`insert into app.org_settings (org_id, key, value) values ($1,'rep_debt_rules','{"on":false}'),($1,'credit_gate','{"on":false}')
    on conflict (org_id, key) do update set value = excluded.value`, [org]);
  await as(USERS.admin, `select app.ensure_cash_accounts($1)`, [org]).catch(() => {});

  const E = Object.fromEntries((await all(`select m.roles[1] r, m.employee_id e from app.members m where m.org_id = $1 and m.employee_id is not null`, [org])).map((x) => [x.r, x.e]));
  // 找货人 / 复核人要不同的人: 多建两个仓管
  const mkEmp = async (name, dept, role) => (await one(`insert into app.employees (org_id, short_name, full_name, department, position, sys_role) values ($1,$2,$2,$3,$3,$4) returning id`, [org, name, dept, role])).id;
  E.p2 = await mkEmp('测试仓管 A', '仓库', 'picker').catch(async () => (await one(`insert into app.employees (org_id, short_name, department, position) values ($1,'测试仓管 A','仓库','仓管') returning id`, [org])).id);
  E.p3 = await mkEmp('测试仓管 B', '仓库', 'picker').catch(async () => (await one(`insert into app.employees (org_id, short_name, department, position) values ($1,'测试仓管 B','仓库','仓管') returning id`, [org])).id);
  log('员工准备好了');

  // 有库存、四档价都有的本地物料
  const P = await all(`select p.id, p.code, p.model, s.id stock_id, s.qty_on_hand q, w.code wh
    from app.products p join app.stock_items s on s.product_id = p.id join app.warehouses w on w.id = s.warehouse_id and w.kind = 'local'
    where p.org_id = $1 and s.qty_on_hand - s.qty_reserved >= 300
      and (select count(*) from app.product_prices pp where pp.product_id = p.id and pp.price > 0) >= 4
    order by s.qty_on_hand desc limit 60`, [org]);
  // 客户: 有档位的正式客户, 定档确认, 设欠款上限 / 账期
  const C = await all(`select id, code, name, tier from app.customers where org_id = $1 and status = 'active' and tier is not null and coalesce(supply,'local') = 'local' order by code limit 30`, [org]);
  for (const c of C) {
    await as(USERS.admin, `select app.confirm_customer_tier($1,$2,'confirm',2,'测试版：定档')`, [c.id, c.tier]).catch(() => {});
    await as(USERS.admin, `select app.set_customer_terms($1,5000000,30,false,null)`, [c.id]).catch(() => {});
  }
  log(`物料 ${P.length} 个、客户 ${C.length} 个`);
  if (P.length < 10 || C.length < 5) { report.fail.push({ name: '准备', err: `物料 ${P.length} / 客户 ${C.length} 不够` }); return report; }

  const pick = (i, n) => Array.from({ length: n }, (_, k) => P[(i * 3 + k * 7) % P.length]);
  const lines = (i, n, base = 10) => pick(i, n).map((p, k) => ({ product_id: p.id, qty_req: base + ((i + k) % 5) * 10 }));

  // ── 单据推进的每一步 (和界面调用的同一组函数) ──
  const S = {
    quote: (cust, ls, note) => val(USERS.manager, `select app.create_quote_priced($1,$2,'XOF',$3,$4)`, [org, cust, JSON.stringify(ls), note || null]),
    confirm: (d) => as(USERS.hotline, `select app.quote_confirm($1,'测试：客户确认数量','whatsapp',null,null,true)`, [d]),
    pick: async (d, picker = E.picker, shortBy = 0) => {
      await as(USERS.manager, `select app.assign_picker($1,$2,'测试派单')`, [d, picker]);
      const ls = await all(`select id, qty_req from app.deal_lines where deal_id = $1 order by seq`, [d]);
      for (const [k, l] of ls.entries()) {
        const q = k === 0 && shortBy ? Math.max(0, l.qty_req - shortBy) : l.qty_req;
        await as(USERS.picker, `select app.pick_tick($1,$2,$3)`, [l.id, q, q < l.qty_req ? '货架上就这么多' : null]);
      }
      await as(USERS.picker, `select app.submit_pick_ticks($1,$2,$3)`, [d, photo('pick'), picker]);
    },
    cconfirm: (d) => as(USERS.hotline, `select app.customer_confirm($1,'测试：客户在群里确认','whatsapp',$2,null)`, [d, photo('confirm')]),
    review: (d, reviewer = E.p3) => as(USERS.manager, `select app.review_pick_fixed($1,$2,$3,'[]','[]')`, [d, reviewer, photo('pack')]),
    ship: (d, items = null, at = null) => val(USERS.manager, `select app.ship($1,coalesce($2::timestamptz, now()),'yango_moto','+225 07 00 00 00','客户店铺',$3,$4)`, [d, at, photo('yango'), items && JSON.stringify(items)]),
    sign: async (d) => { for (const s of await all(`select id from app.shipments where deal_id = $1 and signed_at is null`, [d])) await as(USERS.hotline, `select app.sign_receipt($1,$2,now(),'测试收货人','0700000001','老板')`, [s.id, photo('sign')]); },
    balance: (d) => as(USERS.finance, `select app.confirm_balance($1,'whatsapp',$2,'测试：对账')`, [d, photo('balance')]),
    pay: async (cust, amount, extra = {}) => {
      const acc = extra.account || (await one(`select id from app.cash_accounts where org_id = $1 and name ilike '%wave%' order by name limit 1`, [org]))?.id;
      return val(USERS.finance, `select app.record_receipt2($1,$2)`, [org, JSON.stringify({ customer_id: cust, received_on: extra.on || day(0), amount_landed: amount, amount_paid: amount, currency: 'XOF', method: 'wave', account_id: acc, proof: photo('pay'), alloc_mode: extra.mode || 'oldest', targets: extra.targets || [], ...extra.p })]);
    },
  };
  const toShipped = async (c, ls, o = {}) => {
    const d = await S.quote(c.id, ls, o.note); await S.confirm(d); await S.pick(d, E.picker, o.short || 0);
    await S.cconfirm(d); await S.review(d); await S.ship(d); return d;
  };
  const due = async (d) => Number((await one(`select due from app.v_deal_due where deal_id = $1`, [d]))?.due || 0);

  // ── 1. 订单主线: 每一站都留几张单 ──
  const stages = [['只报价', 0], ['已确认待找货', 1], ['找货中', 2], ['销售单待客户确认', 3], ['待复检', 4], ['已出库待签收', 5], ['已签收待对账', 6], ['已对账待收款', 7], ['已收款完结', 8]];
  let i = 0;
  for (const [label, upto] of stages) for (let k = 0; k < 2; k++) {
    const c = C[i % C.length]; const ls = lines(i, 3 + (i % 3)); i++;
    await run(`主线·${label}`, async () => {
      const d = await S.quote(c.id, ls, `测试：${label}`);
      if (upto >= 1) await S.confirm(d);
      if (upto === 2) { await as(USERS.manager, `select app.assign_picker($1,$2,'测试派单')`, [d, E.picker]); return; }
      if (upto >= 3) await S.pick(d);
      if (upto >= 4) await S.cconfirm(d);
      if (upto >= 5) { await S.review(d); await S.ship(d); }
      if (upto >= 6) await S.sign(d);
      if (upto >= 7) await S.balance(d);
      if (upto >= 8) await S.pay(c.id, await due(d), { mode: 'oldest' });
    });
  }
  log('订单主线做完');

  // ── 2. 分支 ──
  for (let k = 0; k < 3; k++) await run('分支·找货少了', async () => { const c = C[(i++) % C.length]; const d = await S.quote(c.id, lines(i, 3)); await S.confirm(d); await S.pick(d, E.picker, 5); await S.cconfirm(d); });
  for (let k = 0; k < 3; k++) await run('分支·分批出库', async () => {
    const c = C[(i++) % C.length]; const d = await S.quote(c.id, lines(i, 3, 40)); await S.confirm(d); await S.pick(d); await S.cconfirm(d); await S.review(d);
    const ls = await all(`select id, qty_supply q from app.deal_lines where deal_id = $1 order by seq`, [d]);
    await S.ship(d, ls.map((l) => ({ line_id: l.id, qty: Math.floor((l.q || 0) / 2) })).filter((x) => x.qty > 0));
  });
  for (let k = 0; k < 3; k++) await run('分支·作废', async () => { const c = C[(i++) % C.length]; const d = await S.quote(c.id, lines(i, 2)); await S.confirm(d); await as(USERS.manager, `select app.cancel_deal($1,'测试：客户不要了')`, [d]); });
  for (let k = 0; k < 2; k++) await run('分支·拆单', async () => {
    const c = C[(i++) % C.length]; const d = await S.quote(c.id, lines(i, 4)); await as(USERS.hotline, `select app.quote_confirm($1,'测试：客户确认','whatsapp',null,null,false)`, [d]);
    const l = await one(`select id, qty_req from app.deal_lines where deal_id = $1 order by seq limit 1`, [d]);
    await as(USERS.manager, `select app.split_deal_qty($1,$2,$3,'测试：一部分下周再发')`, [d, JSON.stringify([{ line_id: l.id, qty: Math.floor(l.qty_req / 2) }]), day(-7)]);
  });
  for (let k = 0; k < 2; k++) await run('分支·追加货', async () => {
    const c = C[(i++) % C.length]; const d = await S.quote(c.id, lines(i, 2)); await S.confirm(d); await S.pick(d); await S.cconfirm(d);
    await as(USERS.manager, `select app.start_addon($1,$2,'测试：客户还要加')`, [d, JSON.stringify([{ product_id: P[(i + 11) % P.length].id, qty: 20 }])]);
  });
  for (let k = 0; k < 2; k++) await run('分支·整单折扣', async () => {
    const c = C[(i++) % C.length]; const d = await S.quote(c.id, lines(i, 3)); await S.confirm(d); await S.pick(d);
    const t = Number((await one(`select sum(coalesce(unit_price,0) * coalesce(qty_supply, qty_req)) t from app.deal_lines where deal_id = $1`, [d])).t);
    await as(USERS.admin, `select app.apply_deal_discount($1,$2,'测试：老客户整单优惠')`, [d, Math.round(t * 0.97)]);
  });
  for (let k = 0; k < 2; k++) await run('分支·价格待定先出库', async () => {
    const c = C[(i++) % C.length]; const d = await S.quote(c.id, lines(i, 2)); await S.confirm(d); await S.pick(d); await S.cconfirm(d); await S.review(d);
    await as(USERS.admin, `select app.allow_ship_unpriced($1,'测试：客户要先拿货，价格下周谈')`, [d]); await S.ship(d);
  });
  for (let k = 0; k < 2; k++) await run('分支·收货差异', async () => {
    const c = C[(i++) % C.length]; const d = await toShipped(c, lines(i, 2));
    const sh = await one(`select s.id, sl.deal_line_id, sl.qty from app.shipments s join app.shipment_lines sl on sl.shipment_id = s.id where s.deal_id = $1 limit 1`, [d]);
    await as(USERS.hotline, `select app.report_discrepancy($1,'short',$2,$3,'测试：客户说少了 2 个')`, [sh.id, JSON.stringify([{ deal_line_id: sh.deal_line_id, qty: 2 }]), photo('disc')]);
  });
  for (let k = 0; k < 3; k++) await run('分支·退货', async () => {
    const c = C[(i++) % C.length]; const d = await toShipped(c, lines(i, 2)); await S.sign(d);
    const l = await one(`select id from app.deal_lines where deal_id = $1 order by seq limit 1`, [d]);
    const r = await val(USERS.hotline, `select app.request_return($1,'quality','测试：屏幕有亮点',$2,null,now(),$3)`, [d, JSON.stringify([{ line_id: l.id, qty: 3 }]), photo('ret')]);
    if (k < 2) await as(USERS.admin, `select app.decide_return($1,true,'测试：同意退')`, [r]);
  });
  log('分支做完');

  // ── 3. 钱 ──
  for (let k = 0; k < 4; k++) await run('钱·冲最老的', async () => { const c = C[(i++) % C.length]; const a = await toShipped(c, lines(i, 2)); const b = await toShipped(c, lines(i + 1, 2)); await S.pay(c.id, (await due(a)) + Math.round((await due(b)) / 2)); });
  for (let k = 0; k < 3; k++) await run('钱·预付', async () => { const c = C[(i++) % C.length]; await S.pay(c.id, 500000 + k * 100000); });
  for (let k = 0; k < 3; k++) await run('钱·部分付款', async () => { const c = C[(i++) % C.length]; const d = await toShipped(c, lines(i, 3)); await S.pay(c.id, Math.round((await due(d)) * 0.4)); });
  log('钱做完');

  // ── 结束: 恢复规则, 做总账检查 ──
  await db.query(`update app.org_settings set value = '{"on":true}' where org_id = $1 and key in ('rep_debt_rules','credit_gate')`, [org]);
  report.ledger = await all(`select * from app.ledger_check($1)`, [org]).catch((e) => [{ err: e.message }]);
  report.deals = Number((await one(`select count(*) n from app.deals where org_id = $1`, [org])).n);
  return report;
}
