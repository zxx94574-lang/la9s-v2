// 中 / English / Français. The Chinese text is the key: t('经营总览') → 'Tableau de bord' in French.
// A string with no translation yet falls back to Chinese, so the app never shows a blank.
// Coverage today: navigation, top bar, statuses, workflow steps, customer documents, common buttons.
let LANG = (() => { try { return JSON.parse(localStorage.getItem('la9s.lang')) || 'zh'; } catch { return 'zh'; } })();
export const getLang = () => LANG;
export function setLang(l) { LANG = l; try { localStorage.setItem('la9s.lang', JSON.stringify(l)); } catch { /* ignore */ } }
export const LANGS = [['zh', '中文'], ['en', 'English'], ['fr', 'Français']];

const D = {
  // navigation
  '工作台': ['Workspace', 'Espace de travail'], '经营总览': ['Dashboard', 'Tableau de bord'], '我的待办': ['My tasks', 'Mes tâches'],
  '销售主链': ['Sales', 'Ventes'], '新建询单 / 报价': ['New quote', 'Nouveau devis'], '订单总览': ['Orders', 'Commandes'],
  '客户': ['Customers', 'Clients'], '客户档案': ['Customer files', 'Fiches clients'], '热线回访': ['Hotline follow-up', 'Suivi hotline'], '销售拜访': ['Sales visits', 'Visites commerciales'], '客户拜访': ['Customer visits', 'Visites clients'],
  '财务': ['Finance', 'Finance'], '收款与冲账': ['Receipts', 'Encaissements'], '客户总账 Balance': ['Customer balance', 'Balance clients'], '资金账户': ['Cash accounts', 'Comptes de trésorerie'],
  '仓库': ['Warehouse', 'Entrepôt'], '库存（实存/预占/可售）': ['Stock', 'Stock'], '未满足需求': ['Unmet demand', 'Demande non servie'], '备货看板': ['Replenishment', 'Réassort'],
  '物料名称管理（中方）': ['Item names (admin)', 'Noms des articles (admin)'], '物料与定价': ['Items & pricing', 'Articles et prix'], '数据导入': ['Data import', 'Import de données'],
  '后续版本': ['Coming later', 'Plus tard'], '设置': ['Settings', 'Paramètres'], '岗位': ['Role', 'Poste'], '语言': ['Language', 'Langue'],
  // roles
  '中方': ['Management (CN)', 'Direction (CN)'], '仓库主管': ['Warehouse supervisor', 'Chef d’entrepôt'], '热线': ['Hotline', 'Hotline'],
  '销售': ['Sales rep', 'Commercial'], '仓库管理员': ['Warehouse clerk', 'Magasinier'], '找货员': ['Warehouse clerk', 'Magasinier'],
  // statuses
  '已报价': ['Quoted', 'Devis envoyé'], '热线已确认': ['Hotline confirmed', 'Confirmé par hotline'], '找货中 · 已预占': ['Picking · reserved', 'Préparation · réservé'],
  '已初拣 · 待出销售订单': ['Picked · awaiting sales order', 'Préparé · bon de commande à faire'], '待客户确认': ['Awaiting customer', 'En attente du client'],
  '待复检打包': ['To check & pack', 'À contrôler et emballer'], '已打包 · 待出库': ['Packed · to ship', 'Emballé · à expédier'],
  '部分出库': ['Partly shipped', 'Expédié en partie'], '已出库': ['Shipped', 'Expédié'], '已作废': ['Voided', 'Annulé'], '已取消': ['Voided', 'Annulé'],
  // steps
  '报价': ['Quote', 'Devis'], '热线确认': ['Hotline', 'Hotline'], '找货单': ['Pick list', 'Bon de préparation'], '初拣': ['Picking', 'Préparation'],
  '销售订单': ['Sales order', 'Bon de commande'], '客户确认': ['Customer OK', 'Accord client'], '复检打包': ['Check & pack', 'Contrôle et emballage'],
  '出库': ['Shipping', 'Expédition'], '收款': ['Payment', 'Paiement'], '退货': ['Returns', 'Retours'],
  // documents (customer facing)
  '报价单': ['Quotation', 'Devis'], '对账单': ['Statement', 'Relevé de compte'], '退货对账单': ['Return statement', 'Relevé de retour'],
  '编码': ['Code', 'Code'], '种类': ['Type', 'Type'], '型号': ['Model', 'Modèle'], '通用性': ['Compatible', 'Compatible'],
  '数量': ['Qty', 'Qté'], '供货数量': ['Qty supplied', 'Qté livrée'], '单价': ['Unit price', 'Prix unitaire'], '金额': ['Amount', 'Montant'], '合计': ['Total', 'Total'],
  '个型号': ['models', 'modèles'], '件': ['pcs', 'pcs'], '本单': ['This order', 'Cette commande'], '应收': ['Due', 'À payer'], '实收': ['Paid', 'Payé'],
  '待付': ['Balance', 'Reste à payer'], '已付清': ['Paid in full', 'Soldé'], '总账': ['Account', 'Compte'], '总账（含本单）': ['Account (incl. this order)', 'Compte (cette commande incluse)'],
  '累计购买': ['Total bought', 'Total acheté'], '累计已付': ['Total paid', 'Total payé'], '累计退货': ['Total returned', 'Total retourné'],
  '当前欠款': ['Amount owed', 'Montant dû'], '已结清': ['Settled', 'Soldé'], '当前客户无欠款，此为预付': ['No debt — prepaid', 'Aucune dette — avance'],
  '未结清订单': ['Unpaid orders', 'Commandes non soldées'], '其余': ['Other', 'Autres'], '单合计': ['orders total', 'commandes au total'],
  '生成时间': ['Generated', 'Généré le'], '金额单位': ['Currency', 'Devise'],
  // common buttons
  '复制图片': ['Copy image', 'Copier l’image'], '复制文字': ['Copy text', 'Copier le texte'], '打印': ['Print', 'Imprimer'],
  '保存': ['Save', 'Enregistrer'], '取消': ['Cancel', 'Annuler'], '确认': ['Confirm', 'Confirmer'], '搜索': ['Search', 'Rechercher'],
  // 11-25: 页面标题 / 页签 / 列名 / 常用按钮（屏幕上整段文字完全一样时自动翻译，见 domTranslate）
  '全部': ['All', 'Tout'], '关闭': ['Close', 'Fermer'], '确定': ['OK', 'OK'], '知道了': ['Got it', 'Compris'], '再看看': ['Not now', 'Plus tard'], '记下': ['Save', 'Noter'],
  '✎ 修改': ['✎ Edit', '✎ Modifier'], '保存选项': ['Save options', 'Enregistrer'], '恢复默认': ['Reset', 'Par défaut'], '处理': ['Handle', 'Traiter'], '批准': ['Approve', 'Approuver'], '解锁': ['Unlock', 'Déverrouiller'],
  '筛选': ['Filter', 'Filtrer'], '分组': ['Group', 'Grouper'], '导出': ['Export', 'Exporter'], '列': ['Columns', 'Colonnes'], '筛选方案': ['Saved filters', 'Filtres'], '卡片': ['Cards', 'Cartes'], '表格': ['Table', 'Tableau'],
  '本日': ['Today', 'Aujourd’hui'], '本周': ['This week', 'Semaine'], '本月': ['This month', 'Mois'], '本季度': ['Quarter', 'Trimestre'], '本年度': ['Year', 'Année'], '自定义': ['Custom', 'Personnalisé'],
  '订单': ['Orders', 'Commandes'], '订单号': ['Order no.', 'N° commande'], '单号': ['No.', 'N°'], '单': ['orders', 'cmd'], '笔': ['items', 'lignes'], '下单': ['Order', 'Commander'], '询单': ['Inquiries', 'Demandes'], '询单号': ['Inquiry no.', 'N° demande'],
  '出库单': ['Delivery notes', 'Bons de sortie'], '出库单号': ['Delivery no.', 'N° bon de sortie'], '出库数量': ['Qty shipped', 'Qté sortie'], '出库片数': ['Pcs shipped', 'Pcs sorties'], '出库日': ['Ship date', 'Date sortie'], '出库日期': ['Ship date', 'Date sortie'], '最近出库': ['Last shipped', 'Dernière sortie'],
  '入库': ['Receive', 'Entrée'], '入仓号': ['Warehouse entry no.', 'N° d’entrée'], '箱号': ['Box no.', 'N° carton'], '发货文件': ['Shipping docs', 'Documents d’envoi'], '发货日': ['Ship date', 'Date d’envoi'], '发货时间': ['Shipped at', 'Envoyé le'],
  '付款': ['Payment', 'Paiement'], '已付': ['Paid', 'Payé'], '未付': ['Unpaid', 'Impayé'], '凭证': ['Proof', 'Justificatif'], '照片': ['Photo', 'Photo'], '找货照片': ['Picking photo', 'Photo préparation'],
  '件数': ['Pieces', 'Pièces'], '片数': ['Pieces', 'Pièces'], '型号数': ['Models', 'Modèles'], '机型': ['Models', 'Modèles'], '通用型号': ['Compatible models', 'Modèles compatibles'], '品牌': ['Brand', 'Marque'], '物料编码': ['Item code', 'Code article'], '物料名称': ['Item name', 'Nom article'],
  '单价 CNY': ['Unit price CNY', 'Prix unitaire CNY'], '金额 XOF': ['Amount XOF', 'Montant XOF'], '成本': ['Cost', 'Coût'], '利润': ['Profit', 'Marge'], '毛利率': ['Margin %', 'Taux de marge'], '销售额': ['Sales', 'Chiffre d’affaires'], '占比': ['Share', 'Part'], '档位': ['Tier', 'Catégorie'], '档位价': ['Tier price', 'Prix catégorie'],
  '库存': ['Stock', 'Stock'], '实存': ['On hand', 'En stock'], '预占': ['Reserved', 'Réservé'], '可售': ['Available', 'Disponible'], '在途': ['In transit', 'En transit'], '库位': ['Bin', 'Emplacement'], '批次': ['Batch', 'Lot'], '还没到': ['Not arrived', 'Pas arrivé'], '预计到': ['ETA', 'Arrivée prévue'], '预计到货': ['ETA', 'Arrivée prévue'],
  '客户编码': ['Customer code', 'Code client'], '客户总账': ['Customer ledger', 'Compte client'], '客户账号': ['Customer accounts', 'Comptes clients'], '客户门店': ['Customer shops', 'Boutiques clients'], '门店': ['Shops', 'Boutiques'], '店': ['Shop', 'Boutique'], '我的门店': ['My shops', 'Mes boutiques'], '我的订单': ['My orders', 'Mes commandes'], '我的对账': ['My statement', 'Mon relevé'], '店里库存': ['Shop stock', 'Stock boutique'],
  '员工': ['Staff', 'Employé'], '员工与工资': ['Staff & payroll', 'Personnel et paie'], '工号': ['Staff ID', 'Matricule'], '全称': ['Full name', 'Nom complet'], '简称': ['Short name', 'Nom court'], '部门': ['Department', 'Service'], '职位': ['Position', 'Poste'], '负责城市': ['City', 'Ville'], '销售员': ['Sales rep', 'Commercial'],
  '电话': ['Phone', 'Téléphone'], '地址': ['Address', 'Adresse'], '城市': ['City', 'Ville'], '地点': ['Place', 'Lieu'], '名字': ['Name', 'Nom'], '账号': ['Account', 'Compte'], '账户': ['Account', 'Compte'],
  '状态': ['Status', 'Statut'], '类型': ['Type', 'Type'], '日期': ['Date', 'Date'], '时间': ['Time', 'Heure'], '哪天': ['Date', 'Date'], '什么时候': ['When', 'Quand'], '开始': ['Start', 'Début'], '到期日': ['Due date', 'Échéance'], '方式': ['Method', 'Mode'], '来源': ['Source', 'Source'], '用途': ['Purpose', 'Usage'],
  '原因': ['Reason', 'Motif'], '备注': ['Note', 'Remarque'], '说明': ['Note', 'Remarque'], '结果': ['Result', 'Résultat'], '动作': ['Action', 'Action'], '谁': ['Who', 'Qui'], '谁提的': ['Requested by', 'Demandé par'], '改了什么': ['What changed', 'Modification'],
  '超期': ['Overdue', 'En retard'], '核对': ['Check', 'Vérifier'], '区分': ['Kind', 'Type'], '业务': ['Business', 'Activité'], '项目': ['Project', 'Projet'], '货': ['Goods', 'Marchandise'], '系统': ['System', 'Système'], '金蝶': ['Kingdee', 'Kingdee'], '金蝶单号': ['Kingdee no.', 'N° Kingdee'], '金蝶状态': ['Kingdee status', 'Statut Kingdee'],
  '需求数量': ['Qty asked', 'Qté demandée'], '订单数量': ['Order qty', 'Qté commandée'], '本次退货数量': ['Return qty', 'Qté retournée'], '采购数': ['Qty ordered', 'Qté achetée'], '被问次数': ['Times asked', 'Demandes'], '下次跟进': ['Next follow-up', 'Prochain suivi'], '客户怎么说': ['Customer said', 'Le client dit'], '客户说哪天付': ['Promised pay date', 'Date promise'],
  '收款单': ['Receipts', 'Encaissements'], '收款单号': ['Receipt no.', 'N° encaissement'], '收到日期': ['Received on', 'Reçu le'], '采购单': ['Purchase orders', 'Bons d’achat'], '采购单号': ['PO no.', 'N° bon d’achat'], '采购单与到货': ['POs & arrivals', 'Achats et arrivages'], '采购与物资申请': ['Purchases & supplies', 'Achats et fournitures'], '物资申请': ['Supply requests', 'Demandes de fournitures'], '需求批次': ['Request batch', 'Lot de demande'],
  'FOB 项目': ['FOB projects', 'Projets FOB'], 'FOB 客户': ['FOB customer', 'Client FOB'], '转本地': ['To local', 'Vers local'],
  // page titles / tabs
  '月报': ['Monthly report', 'Rapport mensuel'], '毛利分析': ['Margins', 'Marges'], '时效与准确率': ['Speed & accuracy', 'Délais et précision'], '规则参数': ['Rules', 'Règles'], '审批': ['Approvals', 'Validations'], '变更记录': ['Change log', 'Journal'], '系统健康': ['System health', 'Santé système'],
  '库位与盘点': ['Bins & count', 'Emplacements et inventaire'], '金蝶同步': ['Kingdee sync', 'Synchro Kingdee'], '国内财务': ['China finance', 'Finance Chine'], '打卡': ['Clock in', 'Pointage'], '培训与 SOP': ['Training & SOP', 'Formation et SOP'], '编码甄别': ['Code review', 'Revue des codes'], '物料名称管理': ['Item names', 'Noms des articles'],
  '经营总览 ': ['Dashboard', 'Tableau de bord'], '库存与库位': ['Stock & bins', 'Stock et emplacements'], '备货与采购': ['Replenish & buy', 'Réassort et achats'], '热线与拜访': ['Hotline & visits', 'Hotline et visites'], '收款与总账': ['Receipts & ledger', 'Encaissements et comptes'], '报告': ['Reports', 'Rapports'], '规则与系统': ['Rules & system', 'Règles et système'],
  '新订单': ['New order', 'Nouvelle commande'], '进行中': ['In progress', 'En cours'], '草稿': ['Draft', 'Brouillon'], '已完成': ['Done', 'Terminé'], '创建时间': ['Created', 'Créé le'], '订单状态': ['Order status', 'Statut'],
  '按订单看': ['By order', 'Par commande'], '按机型看': ['By model', 'Par modèle'], '出库单 / BL': ['Delivery / BL', 'Sorties / BL'], '测试版': ['Test', 'Test'], '返回': ['Back', 'Retour'], '前进': ['Forward', 'Suivant'],
  '科特迪瓦 · 中方管理': ['Côte d’Ivoire · Management', 'Côte d’Ivoire · Direction'], '卡在哪一步': ['Stuck at', 'Bloqué à'], '单据阶段': ['Stage', 'Étape'], '要你注意的': ['Needs attention', 'À surveiller'],
  '首页': ['Home', 'Accueil'], '待办': ['Tasks', 'Tâches'], '更多': ['More', 'Plus'], '销量': ['Sold', 'Vendu'], '本地备货': ['Local stock', 'Stock local'], '待录': ['To enter', 'À saisir'], '已录': ['Entered', 'Saisi'], '不用录': ['Skip', 'Ignorer'],
  '按采购单利润': ['Profit by PO', 'Marge par achat'], '卖了': ['Sold', 'Vendu'], '赚了': ['Profit', 'Gagné'], '还剩': ['Left', 'Reste'], '进了': ['Bought', 'Acheté'], '收入': ['Revenue', 'Recettes'],
  // 11-25 第二批：按钮 / 选项 / 二级标题
  '员工名单': ['Staff list', 'Liste du personnel'], '确认方式': ['Confirmed via', 'Confirmé par'], '按种类': ['By type', 'Par type'], '为空': ['is empty', 'est vide'], '不等于': ['is not', 'différent de'], '不为空': ['is not empty', 'non vide'], '等于': ['equals', 'égal à'], '确认出库': ['Confirm shipping', 'Confirmer la sortie'], '按档位': ['By tier', 'Par catégorie'], '店员': ['Shop staff', 'Vendeur'], '去掉': ['Remove', 'Retirer'], '删除': ['Delete', 'Supprimer'], '其他': ['Other', 'Autre'], '今天': ['Today', 'Aujourd’hui'], '历史价格': ['Past prices', 'Prix passés'], '新潜客': ['New prospect', 'Nouveau prospect'], '选项设置': ['Options', 'Options'], '退货类型': ['Return type', 'Type de retour'], '退款给客户': ['Refund customer', 'Rembourser le client'], '退回': ['Send back', 'Renvoyer'], '迟到报备': ['Late notice', 'Retard signalé'], '请假': ['Leave', 'Congé'], '设品牌': ['Set brand', 'Définir la marque'], '联系客户确认': ['Confirm with customer', 'Confirmer avec le client'], '联系人身份': ['Contact role', 'Rôle du contact'], '老板': ['Owner', 'Patron'], '紧急': ['Urgent', 'Urgent'], '普通': ['Normal', 'Normal'], '粘贴金蝶应收余额': ['Paste Kingdee AR', 'Coller les créances Kingdee'], '粘贴金蝶即时库存': ['Paste Kingdee stock', 'Coller le stock Kingdee'], '看': ['View', 'Voir'], '登记': ['Record', 'Enregistrer'], '物流公司': ['Forwarder', 'Transitaire'], '清除': ['Clear', 'Effacer'], '清空': ['Clear', 'Vider'], '整单折扣': ['Order discount', 'Remise globale'], '放行这张单': ['Release order', 'Libérer la commande'], '改名': ['Rename', 'Renommer'], '收到': ['Received', 'Reçu'], '支出科目': ['Expense type', 'Poste de dépense'], '撤销': ['Undo', 'Annuler'], '撤回确认': ['Withdraw', 'Retirer'], '提交': ['Submit', 'Soumettre'], '换账号': ['Switch account', 'Changer de compte'], '指令规则': ['Directive rules', 'Règles des consignes'], '打开物料档案': ['Open item file', 'Ouvrir la fiche'], '已审核': ['Approved', 'Validé'], '已到齐': ['All arrived', 'Tout arrivé'], '工资单': ['Payslip', 'Bulletin de paie'], '小于': ['less than', 'inférieur à'], '完成': ['Done', 'Terminé'], '大于': ['greater than', 'supérieur à'], '复制明细': ['Copy details', 'Copier le détail'], '备件': ['Spare parts', 'Pièces'], '回收': ['Recycling', 'Recyclage'], '取消这一批': ['Cancel batch', 'Annuler ce lot'], '取消修改': ['Discard', 'Annuler'], '去处理': ['Handle', 'Traiter'], '去做': ['Do it', 'Faire'], '包含': ['contains', 'contient'], '加入': ['Add', 'Ajouter'], '其他人': ['Others', 'Autres'], '修改记录': ['History', 'Historique'], '保存修改…': ['Save…', 'Enregistrer…'], '介于': ['between', 'entre'], '不看': ['Hide', 'Masquer'], '不撤了': ['Keep', 'Garder'], '不同意': ['Reject', 'Refuser'], '不包含': ['does not contain', 'ne contient pas'], '不动': ['Leave it', 'Ne rien faire'], '可以': ['OK', 'OK'], '导出 Excel': ['Export Excel', 'Exporter Excel'], '不行': ['No', 'Non'], '拍照': ['Take photo', 'Photo'], '账户互转': ['Transfer', 'Virement interne'], '记一笔回款': ['Record remittance', 'Enregistrer un rapatriement'], '记一次拜访': ['Log a visit', 'Noter une visite'], '补录需求': ['Log demand', 'Noter une demande'], '给客户开门店': ['Add customer shop', 'Ajouter une boutique'], '签收照片': ['Delivery photo', 'Photo de réception'], '登记收款': ['Record payment', 'Enregistrer un paiement'], '登记想要': ['Log wish', 'Noter un souhait'], '登记到账': ['Record arrival', 'Enregistrer l’arrivée'], '申诉某一天': ['Appeal a day', 'Contester un jour'], '添加条件': ['Add condition', 'Ajouter une condition'], '添加字段': ['Add field', 'Ajouter un champ'], '派': ['Assign', 'Assigner'], '新账户': ['New account', 'Nouveau compte'], '新申请': ['New request', 'Nouvelle demande'], '新建采购单': ['New PO', 'Nouveau bon d’achat'], '新客户（潜客）': ['New prospect', 'Nouveau prospect'], '新地点': ['New place', 'Nouveau lieu'], '新员工': ['New staff', 'Nouvel employé'], '新分组': ['New group', 'Nouveau groupe'], '建询单': ['New inquiry', 'Nouvelle demande'], '定期任务': ['Recurring task', 'Tâche récurrente'], '加这一行': ['Add row', 'Ajouter la ligne'], '加行': ['Add row', 'Ajouter une ligne'], '加联系人': ['Add contact', 'Ajouter un contact'], '加特价': ['Add special price', 'Ajouter un prix spécial'], '加一项': ['Add item', 'Ajouter'], '加一步': ['Add step', 'Ajouter une étape'], '加一批': ['Add batch', 'Ajouter un lot'], '加一列': ['Add column', 'Ajouter une colonne'], '加一个选项': ['Add option', 'Ajouter une option'], '加一个房间': ['Add room', 'Ajouter une pièce'], '加': ['Add', 'Ajouter'], '出库前追加货': ['Add before shipping', 'Ajouter avant sortie'], '下指令': ['New directive', 'Nouvelle consigne'], '驳回': ['Reject', 'Rejeter'], '颜色': ['Color', 'Couleur'], '页面出错了': ['Page error', 'Erreur de page'], '问付款计划': ['Ask payment plan', 'Demander un plan de paiement'], '错码': ['Wrong code', 'Mauvais code'], '锁上': ['Lock', 'Verrouiller'], '销售提成': ['Sales commission', 'Commission ventes'], '金蝶已审核': ['Kingdee approved', 'Validé Kingdee'], '重置密码': ['Reset password', 'Réinitialiser'], '重新提交审批': ['Resubmit', 'Resoumettre'], '采购行': ['PO lines', 'Lignes d’achat'], '采购入库单': ['Goods receipts', 'Bons de réception'], '采购与到货': ['Purchases & arrivals', 'Achats et arrivages'], '采购': ['Purchasing', 'Achats'], '选货清单': ['Pick list', 'Liste de sélection'], '选货': ['Pick items', 'Choisir'], '选好了': ['Done', 'Terminé'], '选图': ['Choose image', 'Choisir une image'], '退货记录': ['Returns', 'Retours'], '退给客户': ['Return to customer', 'Rendre au client'], '退回重做': ['Send back', 'Renvoyer'], '退出编辑': ['Exit edit', 'Quitter'], '退出登录': ['Log out', 'Déconnexion'], '追加并预占': ['Add & reserve', 'Ajouter et réserver'], '迟到规则': ['Lateness rules', 'Règles de retard'], '迟到原因': ['Late reason', 'Motif du retard'], '还要': ['Still need', 'Encore'], '近一年': ['Last 12 months', '12 derniers mois'], '近 3 个月': ['Last 3 months', '3 derniers mois'], '运费谁出': ['Who pays freight', 'Qui paie le transport'], '过期没到': ['Overdue', 'En retard'], '转正式': ['Make customer', 'Convertir en client'], '转成预付款': ['Make prepayment', 'Convertir en avance'], '转成报价': ['Make quote', 'Convertir en devis'], '超账期': ['Past terms', 'Hors délai'], '走势': ['Trend', 'Tendance'], '资金规则': ['Cash rules', 'Règles de trésorerie'], '资料不全': ['Incomplete', 'Incomplet'], '货在哪': ['Where is it', 'Où est la marchandise'], '账款': ['Receivables', 'Créances'], '账户设置': ['Accounts', 'Comptes'], '请假原因': ['Leave reason', 'Motif du congé'], '询单规则': ['Inquiry rules', 'Règles des demandes'], '记录结论': ['Record conclusion', 'Noter la conclusion'], '认领': ['Claim', 'Réclamer'], '订金': ['Deposit', 'Acompte'], '订单详情': ['Order details', 'Détail commande'], '解冻': ['Unfreeze', 'Débloquer'], '要补货': ['Restock', 'À réapprovisionner'], '草稿规则': ['Draft rules', 'Règles brouillon'], '联系不上': ['Unreachable', 'Injoignable'], '编辑': ['Edit', 'Modifier'], '编码没对上': ['Code mismatch', 'Code non trouvé'], '种类管理': ['Types', 'Types'], '移交客户': ['Transfer customers', 'Transférer des clients'], '结清': ['Settle', 'Solder'], '确认退款': ['Confirm refund', 'Confirmer le remboursement'], '确认转本地': ['Confirm to local', 'Confirmer vers local'], '确认结果': ['Confirm result', 'Confirmer le résultat'], '确认核销': ['Confirm write-off', 'Confirmer la passation en perte'], '立即查看': ['View now', 'Voir'], '红': ['Red', 'Rouge'], '黄': ['Yellow', 'Jaune'], '绿': ['Green', 'Vert'], '蓝': ['Blue', 'Bleu'], '左': ['Left', 'Gauche'], '右': ['Right', 'Droite'], '中': ['Center', 'Centre'],
  '货从哪来': ['Sourced from', 'Provenance'], '这单的货卖给了谁': ['Who bought this PO', 'Acheteurs de ce lot'], '按这单定价（人民币主线）': ['Price from this PO (CNY)', 'Prix depuis ce lot (CNY)'], '按采购单看利润': ['Profit by PO', 'Marge par achat'],
  '库位图': ['Bin map', 'Plan'], '待上架': ['To shelve', 'À ranger'], '盘点': ['Stock count', 'Inventaire'], '门店账号': ['Shop accounts', 'Comptes boutiques'], '客人': ['Guest', 'Visiteur'],
};
export function t(zh) {
  if (LANG === 'zh' || zh == null) return zh;
  const e = D[zh];
  return e ? e[LANG === 'en' ? 0 : 1] : zh;
}
// share of a Chinese string list that has a translation (shown in settings so nobody mistakes partial for done)
export const coverage = () => Object.keys(D).length;

// 屏幕上的文字整段等于词表里的中文时，切到英 / 法自动换掉（列名、按钮、页签、标题…）；切回中文还原。
// 句子 / 带数字的文字不动 —— 那些要页面自己用 t()。
const ORIG = new WeakMap(); const OUT = new WeakMap();
let obs = null;
const HAN = /[一-鿿]/;
function fix(node) {
  if (node.nodeType !== 3) return;
  const raw = ORIG.has(node) ? ORIG.get(node) : node.nodeValue;
  if (!raw || !HAN.test(raw)) return;
  let k = raw.trim(); let e = D[k];
  if (!e) { const m = k.match(/^([^\u4e00-\u9fff]*?)([\u4e00-\u9fff][^]*?)([\s\d.,·:：%]*)$/); if (m && D[m[2].trim()]) { k = m[2].trim(); e = D[k]; } }
  if (LANG === 'zh') { if (ORIG.has(node) && node.nodeValue !== raw) { OUT.set(node, raw); node.nodeValue = raw; } return; }
  if (!e) return;
  const v = raw.replace(k, e[LANG === 'en' ? 0 : 1]);
  if (node.nodeValue !== v) { ORIG.set(node, raw); OUT.set(node, v); node.nodeValue = v; }
}
function walk(root) { const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { if (!n.parentElement?.closest('input,textarea,[contenteditable],.no-tr,.doc,.bl-sheet')) fix(n); } }
export function domTranslate() {
  if (typeof document === 'undefined') return;
  walk(document.body);
  if (obs) return;
  obs = new MutationObserver((ms) => { for (const m of ms) { if (m.type === 'characterData') { const n = m.target; if (OUT.get(n) === n.nodeValue) continue; if (!n.parentElement?.closest('input,textarea,.no-tr,.doc')) { ORIG.delete(n); OUT.delete(n); fix(n); } } else m.addedNodes.forEach((x) => (x.nodeType === 3 ? fix(x) : x.nodeType === 1 && walk(x))); } });
  obs.observe(document.body, { childList: true, subtree: true, characterData: true });
}
