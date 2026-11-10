-- 0015 岗位体系 (Frank 2026-10-31):
-- 中方 (Frank / 汪波 / 财务王振宇) = admin; 主管 = 仓库主管 manager + 销售主管 sales_manager;
-- 员工 = 库管员 picker (搬货的也挂库管员) / 销售员 sales (零售 / 批发 / 区域) / 热线 hotline; 本地录入财务 finance 保留.
-- 回收线以后上: 回收主管 / 回收员 / 回收仓库主管, 先占好岗位, 暂时没有菜单.
-- 只加枚举值 (PostgreSQL 规定新枚举值不能和使用它的语句在同一个事务里), 用法在 0016.
alter type app.role_name add value if not exists 'sales_manager';
alter type app.role_name add value if not exists 'recycle_manager';
alter type app.role_name add value if not exists 'recycler';
alter type app.role_name add value if not exists 'recycle_wh_manager';
