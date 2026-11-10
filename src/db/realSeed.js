// 真实数据版本的初始化 (私有链接用, 不进演示版).
// 只建组织、仓库、岗位账号, 然后全部通过中方的导入函数导入: 物料 → 客户 → 库存 + 库龄 → 在途采购. 历史销售单和出库单不导.
import { USERS, asUser } from './bootstrap.js';
import { seedSops } from './sopDefaults.js';
import { applyPoRemarks } from '../lib/poApply.js';

const chunks = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

export async function seedReal(db, data, asOf = '2026-10-19') {
  const one = async (sql, p = []) => (await db.query(sql, p)).rows[0];
  const as = (u, sql, p) => asUser(db, u, sql, p);
  await db.exec(`
    insert into app.currencies values ('XOF',0),('CNY',2),('USD',2),('GHS',2) on conflict do nothing;
    insert into app.countries values ('CI','科特迪瓦','Côte d''Ivoire','XOF'),('TG','多哥','Togo','XOF'),('BF','布基纳法索','Burkina Faso','XOF'),
      ('ML','马里','Mali','XOF'),('GH','加纳','Ghana','GHS') on conflict do nothing;`);
  const org = (await one(`insert into app.orgs (kind,name,country,base_currency,doc_prefix) values ('hq','LA&9S Côte d''Ivoire','CI','XOF','CI') returning id`)).id;
  // 岗位账号 (只用来右上角切换岗位演示; 真实员工档案由 staff-pack.json 从飞书 STAFF INF 导入)
  const emp = async (short, dept) => (await one(`insert into app.employees (org_id, short_name, department, position) values ($1,$2,$3,$2) returning id`, [org, short, dept])).id;
  const E = { admin: await emp('中方', '中方'), manager: await emp('仓库主管', '仓库'), picker: await emp('仓库管理员', '仓库'), hotline: await emp('热线', '热线'),
    finance: await emp('财务', '财务'), sales: await emp('销售', '销售'), sales_manager: await emp('销售主管', '销售') };
  for (const r of Object.keys(E)) {
    await db.query(`insert into app.members (user_id, org_id, employee_id, roles) values ($1,$2,$3,$4)`, [USERS[r], org, E[r], `{${r}}`]);
  }
  for (const [code, name, kind] of [['LA', 'LA 仓', 'local'], ['9S', '9S 仓', 'local'], ['FOB', 'FOB 仓', 'fob'], ['PENDING', '待检仓', 'pending'], ['SCRAP', '报废仓', 'scrap'], ['RECYCLE', '回收仓', 'recycle']]) {
    await db.query(`insert into app.warehouses (org_id,code,name,kind,supplier) values ($1,$2,$3,$4,$5)`, [org, code, name, kind, code === '9S' ? '9S' : 'LA']);
  }
  await db.query(`insert into app.price_settings (org_id) values ($1)`, [org]);
  const res = {};
  const run = async (key, fn, rows, size, extra = []) => {
    res[key] = { n: 0, bad: [] };
    for (const c of chunks(rows, size)) {
      const [{ r }] = await as(USERS.admin, `select app.${fn}($1,${extra.length ? '$3,' : ''}$2) as r`, [org, JSON.stringify(c), ...extra]);
      res[key].n += (r.new ?? 0) + (r.updated ?? 0) + (r.n ?? 0) + (r.lines ?? 0);
      res[key].bad.push(...(r.bad_rows || []));
    }
  };
  await run('products', 'import_products', data.products, 300);
  // 种类按物料多少排序 (屏幕、电池盖、电池、小板在前)
  await db.query(`update app.categories c set sort = x.rk from (select category_id, row_number() over (order by count(*) desc) rk from app.products where org_id = $1 group by 1) x
    where x.category_id = c.id`, [org]);
  await run('customers', 'import_customers', data.customers, 300);
  await run('stock', 'import_stock', data.stock, 300, [asOf]);
  await run('po', 'import_purchase_orders', data.po, 2000);
  await applyPoRemarks((sql, p) => as(USERS.admin, sql, p), org, data.po);
  if (data.sales_history?.length) await run('sales_history', 'import_sales_history', data.sales_history, 2000);
  await seedSops(as, USERS.admin, org);
  // 同一份金蝶 10-19 库存也存成快照, 「金蝶同步 → 库存对账」开局就有对照
  await as(USERS.admin, `select app.import_kd_snapshot($1,$2,$3)`, [org, asOf, JSON.stringify(data.stock.map((s) => ({ code: s.code, warehouse: s.warehouse, qty: s.qty })))]);
  return { org, res };
}
