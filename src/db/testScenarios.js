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
    catch (e) { report.fail.push({ name, n: (report.ok[name] || 0) + report.fail.filter((f) => f.name === name).length, err: String(e.message || e).slice(0, 300) }); }
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
  // 国内三个岗位账号 (采购 / 商务 / 财务), 右上角切过去看各自的界面
  for (const [r, name] of [['cn_support', '国内采购（测试）'], ['cn_business', '国内商务（测试）'], ['cn_finance', '国内财务（测试）']]) {
    if (!USERS[r] || (await all(`select 1 from app.members where user_id = $1`, [USERS[r]])).length) continue;
    const e = (await one(`insert into app.employees (org_id, short_name, department, position) values ($1,$2,'国内',$2) returning id`, [org, name])).id;
    await db.query(`insert into app.members (user_id, org_id, employee_id, roles) values ($1,$2,$3,$4)`, [USERS[r], org, e, `{${r}}`]);
  }
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
  for (const c of C.slice(0, 12)) await db.query(`update app.customers set owner_employee_id = $2 where id = $1`, [c.id, E.sales]);
  // 欠款类场景专用的客户 (调低上限不影响别的场景)
  const CX = await all(`select id, code, name, tier from app.customers where org_id = $1 and status = 'active' and tier is not null and coalesce(supply,'local') = 'local' order by code offset 30 limit 8`, [org]);
  for (const c of CX) await as(USERS.admin, `select app.confirm_customer_tier($1,$2,'confirm',2,'测试版：定档')`, [c.id, c.tier]).catch(() => {});
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
      return val(USERS.finance, `select app.record_receipt2($1,$2)`, [org, JSON.stringify({ customer_id: cust, received_on: extra.on || day(0), amount_landed: amount, amount_paid: amount, currency: 'XOF', method: 'wave', account_id: acc, proof: photo('pay'), mode: extra.mode || 'oldest', targets: extra.targets || [], ...extra.p })]);
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

  // ── 2b. 熟客直接下单 (0076): 三道关各留几张 ──
  const DO = (c, ls) => val(USERS.manager, `select app.create_direct_order($1,$2,'XOF',$3,$4,'测试：熟客直接下单')`, [org, c.id, JSON.stringify(ls), photo('wa')]);
  for (const c of C.slice(0, 6)) await as(USERS.admin, `select app.set_customer_taker($1,$2)`, [c.id, E.manager]).catch(() => {});
  for (let k = 0; k < 4; k++) await run('直接下单·关都过了', async () => { const r = await DO(C[(i++) % C.length], lines(i, 3)); if (r.state !== 'picking') throw new Error('应该直接下推，结果是 ' + r.state); });
  for (let k = 0; k < 3; k++) await run('直接下单·要议价（等中方）', async () => {
    const ls = lines(i, 2).map((l, n) => n === 0 ? { ...l, requested_price: 100, reason: '测试：客户说别家便宜' } : l);
    const r = await DO(C[(i++) % C.length], ls); if (r.state !== 'price') throw new Error('应该停在价格关，结果是 ' + r.state);
    if (k === 0) await as(USERS.admin, `select app.approve_quote($1,true,'测试：议价批了','[]')`, [r.deal]);
  });
  for (let k = 0; k < 3; k++) await run('直接下单·超欠款（转财务）', async () => {
    const c = CX[k]; await toShipped(c, lines(i, 2));
    await as(USERS.admin, `select app.set_customer_terms($1,1000,30,false,(select owner_employee_id from app.customers where id = $1))`, [c.id]);
    const r = await DO(c, lines(i + 1, 2)); if (r.state !== 'credit') throw new Error('应该停在欠款关，结果是 ' + r.state);
    if (k === 0) { await as(USERS.admin, `select app.set_customer_terms($1,50000000,30,false,(select owner_employee_id from app.customers where id = $1))`, [c.id]); await S.pay(c.id, 1000); }
    if (k === 1) await as(USERS.admin, `select app.approve_quote($1,true,'测试：老客户，特批先找货','[]')`, [r.deal]);
  });
  log('直接下单做完');

  // ── 3. 钱 ──
  for (let k = 0; k < 4; k++) await run('钱·冲最老的', async () => { const c = C[(i++) % C.length]; const a = await toShipped(c, lines(i, 2)); const b = await toShipped(c, lines(i + 1, 2)); await S.pay(c.id, (await due(a)) + Math.round((await due(b)) / 2)); });
  for (let k = 0; k < 3; k++) await run('钱·预付', async () => { const c = C[(i++) % C.length]; await S.pay(c.id, 500000 + k * 100000); });
  for (let k = 0; k < 3; k++) await run('钱·部分付款', async () => { const c = C[(i++) % C.length]; const d = await toShipped(c, lines(i, 3)); await S.pay(c.id, Math.round((await due(d)) * 0.4)); });
  log('钱做完');

  // ── 3b. 钱的其他情况 ──
  const acc = Object.fromEntries((await all(`select name, id from app.cash_accounts where org_id = $1`, [org])).map((a) => [a.name, a.id]));
  const accId = (re) => Object.entries(acc).find(([n]) => re.test(n))?.[1];
  for (let k = 0; k < 3; k++) await run('钱·现金收款', async () => { const c = C[(i++) % C.length]; const d = await toShipped(c, lines(i, 2)); await S.pay(c.id, await due(d), { account: accId(/Cash-XOF/i), p: { method: 'cash' } }); });
  for (let k = 0; k < 3; k++) await run('钱·人民币收款（跨币种）', async () => { const c = C[(i++) % C.length]; const d = await toShipped(c, lines(i, 2)); const x = await due(d);
    await val(USERS.finance, `select app.record_receipt2($1,$2)`, [org, JSON.stringify({ customer_id: c.id, received_on: day(0), amount_landed: Math.round(x / 85), currency: 'CNY', account_currency: 'XOF', rate: 85, method: 'cash', account_id: accId(/Cash-RMB/i), proof: photo('rmb'), mode: 'oldest' })]); });
  for (let k = 0; k < 3; k++) await run('钱·公户代收（钱在 Roland 手里）', async () => { const c = C[(i++) % C.length]; const d = await toShipped(c, lines(i, 2)); await S.pay(c.id, await due(d), { account: accId(/Roland.*Wave/i) || accId(/公户/) }); });
  for (let k = 0; k < 2; k++) await run('钱·员工代收', async () => { const c = C[(i++) % C.length]; const d = await toShipped(c, lines(i, 2));
    await S.pay(c.id, await due(d), { account: null, p: { method: 'cash', account_id: null, collector_employee_id: E.sales } }); });
  for (let k = 0; k < 2; k++) await run('钱·抹零', async () => { const c = C[(i++) % C.length]; const d = await toShipped(c, lines(i, 2)); const x = await due(d); await S.pay(c.id, x - 80); await as(USERS.admin, `select app.write_off($1,80,'测试：零头抹掉')`, [d]); });
  for (let k = 0; k < 2; k++) await run('钱·坏账核销', async () => { const c = C[(i++) % C.length]; const d = await toShipped(c, lines(i, 2)); await as(USERS.admin, `select app.write_off_bad_debt($1,$2,'测试：客户跑了',$3)`, [d, await due(d), photo('bad')]); });
  for (let k = 0; k < 2; k++) await run('钱·价格调整（出库后补差）', async () => { const c = C[(i++) % C.length]; const d = await toShipped(c, lines(i, 2)); await as(USERS.admin, `select app.adjust_price($1,-5000,'测试：出库后给客户让 5000',$2)`, [d, photo('adj')]); });
  for (let k = 0; k < 2; k++) await run('钱·退预付', async () => { const c = CX[6 + k]; await S.pay(c.id, 300000); await as(USERS.admin, `select app.refund_customer($1,$2,50000,$3,'测试：退一部分预付',$4)`, [c.id, accId(/Wave-XOF/i), day(0), photo('refund')]); });
  for (let k = 0; k < 2; k++) await run('钱·撤销收款', async () => { const c = C[(i++) % C.length]; const d = await toShipped(c, lines(i, 2)); const r = await S.pay(c.id, await due(d)); await as(USERS.admin, `select app.void_receipt($1,'测试：登记错了')`, [r]); });
  for (let k = 0; k < 2; k++) await run('钱·撤销出库', async () => { const c = C[(i++) % C.length]; const d = await toShipped(c, lines(i, 2)); const sh = await one(`select id from app.shipments where deal_id = $1 limit 1`, [d]); await as(USERS.admin, `select app.void_shipment($1,'测试：Yango 没接到货')`, [sh.id]); });
  for (let k = 0; k < 2; k++) await run('钱·支出', async () => { await as(USERS.finance, `select app.record_expense($1,$2,$3,'交通费（出租车 / Yango）',$4,'测试：送货')`, [accId(/Wave-XOF/i), 5000 + k * 2500, day(k), photo('exp')]); });
  // 核对到账: 大部分收款中方核对过, 留 3 笔「待核对」给资金账户页看
  for (const r of (await all(`select id from app.receipts where org_id = $1 and verify_status = 'pending' and voided_at is null order by created_at`, [org])).slice(3)) await as(USERS.admin, `select app.verify_receipt($1,'测试：到账核对')`, [r.id]).catch(() => {});
  for (let k = 0; k < 2; k++) await run('钱·回款（汇回国内）', async () => {
    await as(USERS.admin, `select app.ensure_remit_accounts($1)`, [org]);
    const to = (await one(`select id from app.remit_accounts where org_id = $1 order by name limit 1 offset $2`, [org, k]))?.id;
    const rid = await val(USERS.finance, `select app.create_remittance($1,$2)`, [org, JSON.stringify({ from_account_id: (await one(`select a.id from app.cash_accounts a where a.org_id = $1 and a.currency = 'XOF' order by app.account_balance(a.id) desc limit 1`, [org])).id, to_account_id: to, amount_out: 200000 + k * 100000, rate: 85, ref_rate: 85, company: '测试汇款公司', on_date: day(2), proof: photo('remit') })]);
    if (k === 0) { await as(USERS.admin, `select app.remit_arrive($1,7200,$2,$3)`, [rid, day(1), photo('arrive')]); }
  });
  log('钱的其他情况做完');

  // ── 4. FOB: 每个阶段都留几条 ──
  const fobStages = ['applied', 'priced', 'purchasing', 'in_transit', 'arrived', 'deposit', 'released', 'shipped', 'closed', 'cancelled'];
  for (let k = 0; k < 16; k++) {
    const st = fobStages[k % fobStages.length];
    await run(`FOB·${st}`, async () => {
      const c = C[(i++) % C.length]; const wh = k % 3 !== 0;
      const f = await val(USERS.sales, `select app.create_fob($1,$2,$3,$4,'XOF',$5,$6)`, [org, c.id, wh ? 'CI' : 'TG', wh ? 'warehouse' : 'logistics',
        JSON.stringify(pick(k + 40, 2).map((p, n) => ({ product_id: p.id, qty: 200 + n * 100 }))), `测试 FOB：${st}`]);
      if (st === 'applied') return;
      for (const l of await all(`select id from app.fob_lines where project_id = $1`, [f])) await as(USERS.admin, `select app.set_fob_price($1,$2)`, [l.id, 2500 + k * 10]);
      if (st === 'priced') return;
      if (st === 'cancelled') { await as(USERS.manager, `select app.fob_advance($1,'cancelled','{"note":"测试：客户取消"}')`, [f]); return; }
      await as(USERS.manager, `select app.fob_advance($1,'purchasing',$2)`, [f, JSON.stringify({ po_no: `TEST-FOB-${k}` })]);
      if (st === 'purchasing') return;
      await as(USERS.manager, `select app.fob_advance($1,'in_transit',$2)`, [f, JSON.stringify({ logistics: '测试物流', tracking: `TRK${k}`, eta: day(-10) })]);
      const tot = Number((await one(`select total from app.v_fob where id = $1`, [f])).total);
      await as(USERS.finance, `select app.record_fob_payment($1,'deposit',$2,$3,'bank',$4)`, [f, Math.round(tot * 0.3), day(5), photo('fobdep')]);
      if (st === 'in_transit') return;
      if (wh) await as(USERS.manager, `select app.fob_receive($1,$2)`, [f, JSON.stringify((await all(`select id, qty from app.fob_lines where project_id = $1`, [f])).map((l) => ({ line_id: l.id, qty: l.qty })))]);
      else await as(USERS.manager, `select app.fob_advance($1,'arrived','{}')`, [f]);
      if (st === 'arrived' || st === 'deposit') return;
      const full = st !== 'released';
      if (full) await as(USERS.finance, `select app.record_fob_payment($1,'balance',$2,$3,'bank',$4)`, [f, tot - Math.round(tot * 0.3), day(1), photo('fobbal')]);
      await as(USERS.admin, `select app.fob_release($1,$2)`, [f, full ? '测试：收齐了' : '测试：老客户，尾款下周付，先放']);
      if (st === 'released') return;
      await as(USERS.manager, `select app.fob_ship($1,$2,'测试 FOB 出库')`, [f, photo('fobship')]);
    });
  }
  // 0081: FOB 出库的几种情况 (Frank 11-22: 全出 / 分批出 / 不要了转本地)
  const fobOut = [
    ['FOB出库·全出（仓库控货）', 'warehouse', [['all']]],
    ['FOB出库·只出一半（剩下的还在 FOB 仓）', 'warehouse', [['half']]],
    ['FOB出库·分两批出完', 'warehouse', [['half'], ['all']]],
    ['FOB出库·出一半后客户不要了，剩下转 9S 仓（多收订金转预付）', 'warehouse', [['half'], ['local', '9S', 'credit']]],
    ['FOB出库·一片没出客户就不要了，全转 LA 仓（订金不退）', 'warehouse', [['local', 'LA', 'keep']]],
    ['FOB出库·物流控货分批放货', 'logistics', [['half']]],
    ['FOB出库·物流控货到了目的国客户不要了，转 LA 仓（订金要退）', 'logistics', [['local', 'LA', 'refund']]],
  ];
  for (const [k, [name, ctl, steps]] of fobOut.entries()) {
    await run(name, async () => {
      const c = C[(i++) % C.length];
      const f = await val(USERS.sales, `select app.create_fob($1,$2,$3,$4,'XOF',$5,$6)`, [org, c.id, ctl === 'warehouse' ? 'CI' : 'TG', ctl,
        JSON.stringify(pick(k + 70, 2).map((p, n) => ({ product_id: p.id, qty: 200 + n * 100 }))), `测试 ${name}`]);
      for (const l of await all(`select id from app.fob_lines where project_id = $1`, [f])) await as(USERS.admin, `select app.set_fob_price($1,$2)`, [l.id, 2600 + k * 10]);
      await as(USERS.manager, `select app.fob_advance($1,'purchasing',$2)`, [f, JSON.stringify({ po_no: `TEST-FOBOUT-${k}` })]);
      await as(USERS.manager, `select app.fob_advance($1,'in_transit',$2)`, [f, JSON.stringify({ logistics: '测试物流', tracking: `TRKO${k}`, eta: day(-5) })]);
      const tot = Number((await one(`select total from app.v_fob where id = $1`, [f])).total);
      await as(USERS.finance, `select app.record_fob_payment($1,'deposit',$2,$3,'bank',$4)`, [f, Math.round(tot * 0.3), day(4), photo('fobdep')]);
      if (ctl === 'warehouse') await as(USERS.manager, `select app.fob_receive($1,$2)`, [f, JSON.stringify((await all(`select id, qty from app.fob_lines where project_id = $1`, [f])).map((l) => ({ line_id: l.id, qty: l.qty })))]);
      else await as(USERS.manager, `select app.fob_advance($1,'arrived','{}')`, [f]);
      if (steps[0][0] !== 'local') await as(USERS.admin, `select app.fob_release($1,$2)`, [f, '测试：老客户先放，尾款跟上']);
      for (const [what, wh, dep] of steps) {
        if (what === 'all') await as(USERS.manager, `select app.fob_ship2($1,null,$2,'测试：剩下的全出')`, [f, photo('fobout')]);
        else if (what === 'half') await as(USERS.manager, `select app.fob_ship2($1,$2,$3,'测试：先出一半')`, [f, JSON.stringify((await all(`select id, qty from app.fob_lines where project_id = $1`, [f])).map((l) => ({ line_id: l.id, qty: Math.floor(l.qty / 2) }))), photo('fobout')]);
        else await as(USERS.admin, `select app.fob_to_local($1,null,$2,$3,$4)`, [f, wh, '测试：客户资金紧张不要了', dep]);
      }
    });
  }
  log('FOB 做完');

  // ── 5. 拦截: 故意制造, 留着给中方看 ──
  await db.query(`update app.org_settings set value = '{"on":true}' where org_id = $1 and key = 'credit_gate'`, [org]);
  for (let k = 0; k < 2; k++) await run('拦截·超欠款上限（卡在出库前）', async () => { const c = CX[4 + k]; await as(USERS.admin, `select app.set_customer_terms($1,10000,30,false,(select owner_employee_id from app.customers where id = $1))`, [c.id]);
    const d = await S.quote(c.id, lines(i, 3)); await S.confirm(d); await S.pick(d); await S.cconfirm(d); await S.review(d);
    let blocked = false; try { await S.ship(d); } catch { blocked = true; } if (!blocked) throw new Error('超上限没拦住'); });
  await db.query(`update app.org_settings set value = '{"on":false}' where org_id = $1 and key = 'credit_gate'`, [org]);
  for (let k = 0; k < 2; k++) await run('拦截·卖价低于成本（要中方批）', async () => { const c = C[(i++) % C.length]; const ls = lines(i, 2).map((l, n) => n === 0 ? { ...l, unit_price: 1 } : l);
    const d = await val(USERS.admin, `select app.create_quote_priced($1,$2,'XOF',$3,'测试：报了 1 块钱')`, [org, c.id, JSON.stringify(ls)]);
    let blocked = false; try { await S.confirm(d); } catch (e) { blocked = /LOSS_BLOCK/.test(e.message); } if (!blocked) throw new Error('低于成本没拦住'); });
  for (let k = 0; k < 2; k++) await run('拦截·员工改价待批', async () => { const c = C[(i++) % C.length]; const d = await S.quote(c.id, lines(i, 2)); await S.confirm(d); await S.pick(d);
    const l = await one(`select id, unit_price from app.deal_lines where deal_id = $1 order by seq limit 1`, [d]);
    await as(USERS.manager, `select app.request_line_price($1,$2,'测试：客户嫌贵要便宜点')`, [l.id, Math.round(Number(l.unit_price) * 0.9)]); });
  for (let k = 0; k < 2; k++) await run('拦截·冻结库存', async () => { const p = P[(i++) % P.length]; await as(USERS.admin, `select app.freeze_stock($1,20,'待评估（软件 / 版本）',$2)`, [p.stock_id, photo('freeze')]); });
  log('拦截做完');

  // ── 6. 客户 / 热线 / 拜访 / 询单 ──
  const results = ['order', 'quote', 'no_answer', 'later', 'busy'];
  for (let k = 0; k < 12; k++) await run('热线回访', async () => { const c = C[(i++) % C.length]; await as(USERS.hotline, `select app.log_call($1,'spare','call',$2,$3,$4)`, [c.id, results[k % 5], `测试回访 ${k + 1}`, day(-1 - (k % 3))]); });
  for (let k = 0; k < 6; k++) await run('潜客 + 拜访', async () => {
    const pr = await val(USERS.sales, `select app.create_prospect($1,$2,$3,'Yopougon',$4)`, [org, `测试潜客 ${k + 1}`, `07000010${String(k).padStart(2, '0')}`, JSON.stringify({ shop_type: k % 2 ? 'Repair shop' : 'Retail shop', market: 'Siporex' })]);
    await as(USERS.sales, `select app.log_visit($1,$2,$3)`, [pr, k % 3 ? 'interested' : 'order', JSON.stringify({ photo: photo('shop'), activity: 'Réparation', products_wanted: 'LCD', monthly_qty: String(50 + k * 20) })]);
  });
  for (let k = 0; k < 6; k++) await run('询单（员工建）', async () => { const c = C[k]; const q = await val(USERS.sales, `select app.submit_inquiry($1,$2,$3,'测试询单')`, [org, c.id, JSON.stringify(pick(k, 2).map((p) => ({ product_id: p.id, qty: 30 })))]);
    if (k < 3) await as(USERS.admin, `select app.inquiry_convert($1,'[]',null)`, [q]); else if (k === 3) await as(USERS.admin, `select app.inquiry_mark($1,'lost','价格谈不拢')`, [q]); });
  for (let k = 0; k < 4; k++) await run('询单（游客）', async () => { await val(USERS.admin, `select app.guest_inquiry2($1,$2,$3,'测试游客')`, [org, JSON.stringify({ contact: `游客 ${k + 1}`, phone: `0500000${k}00`, city: 'Abobo', level: ['REPAIR', 'RETAIL', 'WHOLESALE', 'MIXED'][k] }), JSON.stringify(pick(k + 5, 2).map((p) => ({ product_id: p.id, qty: 20 })))]); });
  log('客户相关做完');

  // ── 7. 中方指令 / 任务 ──
  for (let k = 0; k < 6; k++) await run('中方指令', async () => {
    const id = await val(USERS.admin, `select app.issue_directive3($1,$2)`, [org, JSON.stringify({ dir_type: '其他', title: ['盘点 LA 仓电池', '给 KABRE 打电话催款', '整理 9S 仓货架', '核对昨天的出库单', '拍新到的屏幕照片', '回访上周的潜客'][k], body: '测试指令', assignees: [k % 2 ? E.picker : E.hotline], due_on: day(k % 3 - 1), report_mode: 'all' })]);
    const ids = await all(`select id from app.directives where group_id = (select group_id from app.directives where id = $1) or id = $1`, [id]).catch(() => [{ id }]);
    if (k >= 2) for (const x of ids) await as(k % 2 ? USERS.picker : USERS.hotline, `select app.ack_directive2($1,'测试：刚看到')`, [x.id]).catch(() => {});
    if (k >= 4) for (const x of ids) await as(k % 2 ? USERS.picker : USERS.hotline, `select app.complete_directive($1,'测试：做完了',$2)`, [x.id, photo('dir')]).catch(() => {});
  });
  // 478 / 480: 制单指令 —— 员工建好单, 交的时候选那张订单
  for (let k = 0; k < 4; k++) await run('指令·制单（WhatsApp 下的单）', async () => {
    const c = C[(k + 3) % C.length];
    await as(USERS.admin, `select app.issue_directive3($1,$2)`, [org, JSON.stringify({ title: `制单：${c.name} 在群里下的单`, body: '客户在 WhatsApp 群里发了单，截图见附件', dir_type: '制单', customer_id: c.id, assignees: [E.manager], due_on: day(-(k % 2)) })]);
    const dir = await one(`select id from app.directives where assignee_employee_id = $1 and dir_type = '制单' and status = 'sent' order by created_at desc limit 1`, [E.manager]);
    if (k === 0) return;                       // 留一条还没做的
    await as(USERS.manager, `select app.ack_directive2($1,null)`, [dir.id]).catch(() => {});
    if (k === 1) return;                       // 留一条收到了在做的
    const d = await S.quote(c.id, lines(k + 90, 3), '测试：照 WhatsApp 截图建的单');
    await as(USERS.manager, `select app.complete_directive2($1,null,null,'deal',$2)`, [dir.id, d]);
    if (k === 3) await as(USERS.admin, `select app.confirm_directive($1,true,'测试：单建得对')`, [dir.id]);
  });
  for (let k = 0; k < 3; k++) await run('指令·催款 / 回电话（不同期限）', async () => {
    await as(USERS.admin, `select app.issue_directive3($1,$2)`, [org, JSON.stringify({ title: ['催 KABRE 把上周的钱付了', '给新客户回个电话', '问问 MODIBO 还要不要 BG6'][k], dir_type: ['催款', '回电话', '回电话'][k], customer_id: C[(k + 7) % C.length].id, assignees: [E.hotline], due_on: day(1 - k) })]);
  });
  log('指令做完');

  // ── 8. 客户账号 + 店里收银 (0077): 一个客户开账号, 老板 + 门店店员, 店里卖货 ──
  await run('客户账号·开账号和门店', async () => {
    const c = C[1];
    const corg = (await one(`insert into app.orgs (kind,name,country,base_currency,doc_prefix) values ('customer',$1,'CI','XOF','TC') returning id`, [c.name])).id;
    await db.query(`update app.customers set linked_org_id = $1, portal_opts = '{"stock":true,"price":true,"inquiry":true}' where id = $2`, [corg, c.id]);
    await db.query(`insert into app.members (user_id, org_id, roles) values ($1,$2,'{boss}') on conflict do nothing`, [USERS.boss, corg]);
    const st = await val(USERS.admin, `select app.create_store($1,'测试门店 1','Abobo','店长（测试）')`, [c.id]);
    await val(USERS.admin, `select app.create_store($1,'测试门店 2','Yopougon','店长 2（测试）')`, [c.id]);
    const sorg = (await one(`insert into app.orgs (kind,name,country,base_currency,doc_prefix,parent_id) values ('store','测试门店 1','CI','XOF','T1',$1) returning id`, [corg])).id;
    await db.query(`update app.portal_stores set org_id = $1 where id = $2`, [sorg, st]);
    await db.query(`insert into app.members (user_id, org_id, roles) values ($1,$2,'{clerk}') on conflict do nothing`, [USERS.clerk, sorg]);
    // 我们给他出两次货 → 自动进他店里
    for (let k = 0; k < 2; k++) await toShipped(c, lines(70 + k, 4, 30));
    await as(USERS.boss, `select app.shop_stock_in('BG6M','电池盖','其他 · A 货',50,800)`);
    await as(USERS.clerk, `select app.shop_stock_in('X6516','屏幕','其他 · 普通',20)`);
    const items = await all(`select id, qty from app.shop_items where customer_id = $1`, [c.id]);
    for (const [n, it] of items.entries()) await as(USERS.boss, `select app.shop_set_price($1,$2)`, [it.id, 1500 + n * 500]);
    let last = null;
    for (let k = 0; k < 16; k++) {
      const it = items[k % items.length]; const q = 1 + (k % 3);
      last = await val(k % 2 ? USERS.clerk : USERS.boss, `select app.shop_sell($1,$2,$3)`, [JSON.stringify([{ item_id: it.id, qty: q }]), ['cash', 'wave', 'orange'][k % 3], k % 5 === 0 ? '批发客户 KONE' : null]);
    }
    const sid = (await one(`select id from app.shop_sales where sale_no = $1 and customer_id = $2`, [last, c.id])).id;
    await as(USERS.boss, `select app.shop_void_sale($1,'测试：客人退回')`, [sid]);
  });
  log('客户账号做完');

  // ── 9. 想要 + 到货分配 (0078) ──
  await run('想要·登记', async () => {
    const ws = [];
    for (let k = 0; k < 12; k++) ws.push(await val(USERS.hotline, `select app.add_want($1,$2,$3,$4,$5)`, [C[(k * 2) % C.length].id, k < 10 ? P[(k * 5) % P.length].id : null, k < 10 ? null : `SPARK ${40 + k}`, 20 + k * 5, `测试：客户说到货叫他 ${k + 1}`]));
    await as(USERS.hotline, `select app.sync_wants($1)`, [org]);
    await db.query(`update app.wants set expires_on = current_date - 1, created_at = now() - interval '20 days' where id = any($1)`, [ws.slice(10, 12)]);
    await as(USERS.hotline, `select app.sync_wants($1)`, [org]);
    for (const [k, id] of ws.slice(0, 6).entries()) await as(USERS.hotline, `select app.want_check($1,$2,$3)`, [id, ['yes', 'yes', 'yes', 'no', 'no_answer', 'yes'][k], k === 3 ? '找别人买了' : null]);
    await as(USERS.admin, `select app.allocate_wants($1,$2,'测试：这批到货先给老客户')`, [org, JSON.stringify([{ want_id: ws[0], qty: 15 }, { want_id: ws[1], qty: 10 }])]);
  });
  log('想要做完');
  // ── 10. 国内: 商务回复申请 / 采购建单 / 财务付款 + 运费 (0082) ──
  const reqs = [];
  for (let k = 0; k < 6; k++) await run(`国内·备货申请（${['商务全回了', '商务全回了', '商务回了一半', '商务回了一半', '还没回', '还没回'][k]}）`, async () => {
    const ps = pick(k * 7 + 90, 3);
    const r = await val(USERS.manager, `select app.save_purchase_request($1,null,$2,$3)`, [org, JSON.stringify({ kind: 'stock', title: `测试：${k + 1} 月备货`, need_by: day(-60 - k) }),
      JSON.stringify(ps.map((p, n) => ({ product_id: p.id, item: p.model, qty: 300 + n * 100 })))]);
    const ls = await all(`select id, qty from app.purchase_request_lines where request_id = $1`, [r]);
    for (const [n, l] of ls.entries()) {
      if (k >= 4 || (k >= 2 && n > 0)) continue;
      await as(USERS.cn_business, `select app.cn_offer($1,$2)`, [l.id, JSON.stringify({ qty: n === 1 ? l.qty - 50 : l.qty, price: 10 + n * 3.5, ship: day(-20 - k), owner: n % 2 ? '9S' : 'LA', note: n === 1 ? '测试：工厂只够这么多' : '' })]);
    }
    reqs.push(r);
  });
  for (let k = 0; k < 5; k++) await run(`国内·采购单付款（${['货款付清 + 运费', '货款付清 + 运费', '只付了订金', '只付了订金', '还没付'][k]}）`, async () => {
    const ps = pick(k * 5 + 120, 2);
    const po = await val(USERS.cn_support, `select app.save_po($1,null,$2,$3)`, [org, JSON.stringify({ po_no: `TEST-CN-${k + 1}`, purpose: 'local', inbound_no: `CG26TEST${k}A`, shipped_on: day(-10 - k), eta: day(k * 3 - 2), batch_name: `测试-海运-${k + 1}` }),
      JSON.stringify(ps.map((p, n) => ({ product_id: p.id, qty: 200 + n * 100, unit_price: 9 + n * 2.5 })))]);
    const g = Number((await one(`select goods_cny from app.v_po_ledger where id = $1`, [po])).goods_cny);
    if (k <= 1) {
      await as(USERS.cn_finance, `select app.record_po_payment($1,$2)`, [po, JSON.stringify({ kind: 'goods', amount: g, currency: 'CNY', xof_per_unit: 85, proof: photo('cnpay'), on_date: day(-12) })]);
      await as(USERS.cn_finance, `select app.record_po_payment($1,$2)`, [po, JSON.stringify({ kind: 'freight', amount: 1800 + k * 300, currency: 'CNY', xof_per_unit: 85, proof: photo('cnfrt'), on_date: day(-9) })]);
    } else if (k <= 3) await as(USERS.cn_finance, `select app.record_po_payment($1,$2)`, [po, JSON.stringify({ kind: 'goods', amount: Math.round(g * 0.3), currency: 'CNY', xof_per_unit: 85, proof: photo('cnpay'), note: '测试：30% 订金' })]);
  });
  log('国内做完');


  // ── 定期任务 (503): 做完的 / 还没做的 / 超时的 各一条 ──
  await run('定期任务·做完 / 没做 / 超时', async () => {
    const mk = (title, who, freq) => as(USERS.admin, `select app.issue_directive2($1,$2)`, [org, JSON.stringify({ title, body: '测试：定期任务', require_photo: true, assignees: [who], report_mode: 'named', reporters: [], recurring: { freq, weekdays: [1, 2, 3, 4, 5, 6, 7], month_days: [1], at: '09:00' } })]);
    await mk('早上拍仓库门口和货架照片', E.picker, 'daily'); await mk('下班前对一遍当天出库单', E.hotline, 'daily'); await mk('把上周没付款的客户列出来', E.manager, 'weekly');
    await as(USERS.admin, `select app.spawn_directives($1)`, [org]);
    const kids = await all(`select d.id, d.title, d.assignee_employee_id from app.directives d where d.org_id = $1 and d.parent_id is not null and d.status = 'sent' order by d.created_at`, [org]);
    const a = kids.find((x) => x.title.startsWith('早上')); const c = kids.find((x) => x.title.startsWith('把上周'));
    if (a) { await as(USERS.picker, `select app.ack_directive2($1,null)`, [a.id]); await as(USERS.picker, `select app.complete_directive($1,'测试：拍了',$2)`, [a.id, photo('dir')]); }
    if (c) await db.query(`update app.directives set due_on = current_date - 1, due_at = now() - interval '10 hours', created_at = now() - interval '2 days' where id = $1`, [c.id]);
  });

  // ── 看板要的「以前的数」(0084): 前 3 个月的历史单 (一部分没收款 → 超账期) + 销售员归属 + 库龄 ──
  const reps = [];
  for (const [n, nm] of ['测试销售 A', '测试销售 B', '测试销售 C'].entries()) reps.push(await mkEmp(nm, '销售', 'sales').catch(async () => (await one(`insert into app.employees (org_id, short_name, department, position) values ($1,$2,'销售','销售员') returning id`, [org, nm])).id));
  for (const [n, c] of C.slice(12).entries()) await db.query(`update app.customers set owner_employee_id = $2 where id = $1`, [c.id, reps[n % reps.length]]);
  for (let k = 0; k < 24; k++) await run(`历史单·${['上个月', '两个月前', '三个月前'][k % 3]}${k % 4 === 3 ? '（没收款）' : ''}`, async () => {
    const c = C[(k * 5 + 3) % C.length]; const back = 32 + (k % 3) * 30 + (k % 9);
    const d = await S.quote(c.id, lines(k + 200, 2 + (k % 3), 20), '测试：历史单'); await S.confirm(d); await S.pick(d); await S.cconfirm(d); await S.review(d);
    await S.ship(d, null, new Date(Date.now() - back * 864e5).toISOString());
    await db.query(`update app.deals set owner_employee_id = coalesce((select owner_employee_id from app.customers where id = $2), owner_employee_id) where id = $1`, [d, c.id]);
    if (k % 4 === 3) return;
    await S.sign(d); await S.balance(d); await S.pay(c.id, await due(d), { on: day(back - 3) });
  });
  // 库龄: 入库流水摊到 0–200 天前 (测试库都是今天导进来的, 不摊就全是「0–30 天」)
  await db.query(`update app.stock_moves m set at = now() - ((abs(hashtext(m.stock_item_id::text)) % 200) || ' days')::interval
    from app.stock_items si join app.products p on p.id = si.product_id where si.id = m.stock_item_id and p.org_id = $1 and m.qty > 0 and m.reason in ('opening', 'grn', 'adjust')`, [org]);
  // 待办「订单」(503): 把一部分没走完的单往前挪几个 / 几十个小时, 看得到「卡在哪一步」(不挪就全是刚建的)
  const openD = await all(`select d.id from app.deals d where d.org_id = $1 and d.status not in ('cancelled','shipped') order by d.created_at limit 40`, [org]);
  for (const [k, d] of openD.entries()) { if (k % 3 === 2) continue; const h = [5, 9, 26, 31, 50, 74][k % 6];
    await db.query(`update app.deal_events set at = at - ($2 || ' hours')::interval where deal_id = $1`, [d.id, h]);
    await db.query(`update app.deals set created_at = created_at - ($2 || ' hours')::interval where id = $1`, [d.id, h]); }
  log('历史单 / 库龄做完');

  // ── 结束: 恢复规则, 做总账检查 ──
  await db.query(`update app.org_settings set value = '{"on":true}' where org_id = $1 and key in ('rep_debt_rules','credit_gate')`, [org]);
  report.ledger = await all(`select * from app.ledger_check($1)`, [org]).catch((e) => [{ err: e.message }]);
  report.deals = Number((await one(`select count(*) n from app.deals where org_id = $1`, [org])).n);
  return report;
}
