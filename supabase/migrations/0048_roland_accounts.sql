-- LA&9S Operations · 0048 Roland 公户两个账户 (Frank 2026-11-14 14:15)
-- 客户可以把钱付到 Roland 名下的公户 (Wave 或银行). 付到这里 = 钱在 Roland 手里, 还没到我们手; 他交回才算到.
-- Frank: 不确定他是不是两个账号都有, 先两个都加上, 没有的以后删. 上限 / 天数沿用 0010 的公户规矩 (500 万 XOF / 7 天).
-- 持有人 = 员工档案里名字带 ROLAND 的那位 (没找到就先空着, 在「资金账户 › 账户设置」里选).

insert into app.cash_accounts (org_id, name, kind, currency, holder_employee_id, hold_limit, hold_days, note)
select o.id, x.name, x.kind, 'XOF',
       (select e.id from app.employees e
         where e.org_id = o.id and e.active
           and (upper(coalesce(e.short_name, '')) like '%ROLAND%' or upper(coalesce(e.full_name, '')) like '%ROLAND%')
         order by e.created_at limit 1),
       5000000, 7,
       '客户付到这里 = 钱在 Roland 手里，还没到我们手；他交回才算到账'
from app.orgs o
cross join (values ('Roland 公户 · Wave', 'wave'), ('Roland 公户 · 银行', 'bank')) as x(name, kind)
where exists (select 1 from app.currencies c where c.code = 'XOF')
on conflict (org_id, name) do nothing;
