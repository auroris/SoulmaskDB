'use strict';
/**
 * Chinese (simplified) catalog. Starter content — translations are
 * best-effort and should be reviewed by a native speaker. Missing keys
 * silently fall back to the English catalog, so this file is safe to
 * grow incrementally.
 *
 * The gloss table here is mostly Pinyin → Hanzi (recovering what the
 * game devs presumably wrote before romanizing for Unreal identifiers).
 * Tokens not listed below — including English ones like "Conveyor",
 * "NPC", "Monster" — fall back to the raw token, which is fine.
 */
window.SMDB_LOCALES = window.SMDB_LOCALES || {};
window.SMDB_LOCALES.zh = {
  '_displayName':                   '中文',

  // ------------------------------------------------------------- page chrome
  'ui.title':                       'Soulmask 存档浏览器',
  'ui.header.title':                'SOULMASK 存档',
  'ui.header.verifyCodec':          '验证编解码器',
  'ui.header.verifyCodec.title':    '对每个二进制块进行编解码往返测试并报告失败',
  'ui.header.steamCache':           'Steam 缓存 ({count})',
  'ui.header.steamCache.title':     '清除本地缓存的 Steam 显示名 (开发用)',
  'ui.header.stash':                '暂存 ({count})',
  'ui.header.stash.title':          '打开行暂存',
  'ui.header.download':             '下载修改后的 .db',
  'ui.header.changedBadge':         '● 未保存的更改',
  'ui.header.language':             '语言',

  // ----------------------------------------------------------------- filters
  'ui.search.placeholder':          '过滤 (同时搜索二进制块内的字符串)',
  'ui.kindFilter.all':              '全部类型',
  'ui.kindFilter.system':           '系统行',
  'ui.kindFilter.player':           '玩家',
  'ui.kindFilter.inventory':        '物品栏',
  'ui.kindFilter.npc':              'NPC',
  'ui.kindFilter.animal':           '动物',
  'ui.kindFilter.container':        '容器 (箱子)',
  'ui.kindFilter.station':          '工作站 (工作台/灯)',
  'ui.kindFilter.building':         '建筑',
  'ui.kindFilter.furniture':        '家具',
  'ui.kindFilter.vegetation':       '植被 / 农田',
  'ui.kindFilter.region':           '片区 (JianZhuPianQu)',
  'ui.kindFilter.vehicle':          '船只 / 载具',
  'ui.kindFilter.other':            '其他',

  // ----------------------------------------------------------- initial state
  'ui.empty.choose':                '选择一个 <code>world.db</code> 文件开始。',

  // ------------------------------------------------------------ detail panel
  'ui.detail.close':                '关闭',
  'ui.detail.numeric':              '数值 (只读)',
  'ui.detail.editable':             '可编辑字段',
  'ui.detail.saveChanges':          '保存更改',
  'ui.detail.revert':               '撤销',
  'ui.detail.stashRow':             '⎘ 暂存',
  'ui.detail.deleteRow':            '删除行',
  'ui.detail.transformHeading':     '变换 (已解析)',
  'ui.detail.position':             '位置',
  'ui.detail.rotation':             '旋转',
  'ui.detail.scale':                '缩放',

  // ---------------------------------------------------------- steam section
  'ui.steam.heading':               'Steam 账号',
  'ui.steam.personaName':           '显示名',
  'ui.steam.avatar':                '头像',
  'ui.steam.openProfile':           '↗ 打开 Steam 资料页',
  'ui.steam.savePersona':           '保存显示名',

  // ----------------------------------------------------------- summary line
  'ui.summary.total':               '总计',

  // ------------------------------------------------------------- pagination
  'ui.pagination.first':            '« 首页',
  'ui.pagination.prev':             '‹ 上一页',
  'ui.pagination.next':             '下一页 ›',
  'ui.pagination.last':             '末页 »',
  'ui.pagination.pageOf':           '第 {page} 页 / 共 {pages} 页',

  // ------------------------------------------------------------- stash dialog
  'ui.stash.heading':               '行暂存',
  'ui.stash.close':                 '关闭',
  'ui.stash.export':                '⤓ 导出到文件',
  'ui.stash.importLabel':           '⤒ 导入:',
  'ui.stash.clear':                 '清空',
  'ui.stash.paste':                 '粘贴到此处',
  'ui.stash.edit':                  '编辑',
  'ui.stash.delete':                '删除',

  // ------------------------------------------------------------ verify dialog
  'ui.verify.heading':              '编解码器往返测试结果',
  'ui.verify.close':                '关闭',
  'ui.verify.running':              '运行中…',
  'ui.verify.loadingBlobs':         '加载二进制块…',

  // =========================================================================
  // gloss.* — Pinyin → 汉字. Best-effort; correct any mistakes here. Tokens
  // not listed fall back to the raw Pinyin (still readable to most users).
  // =========================================================================
  'gloss.JianZhu':       '建筑',
  'gloss.PianQu':        '片区',
  'gloss.DongWu':        '动物',
  'gloss.YeZhu':         '野猪',
  'gloss.XieZi':         '蝎子',
  'gloss.Yu':            '鱼',
  'gloss.Niao':          '鸟',
  'gloss.ZhiBei':        '植被',
  'gloss.ZhiWu':         '植物',
  'gloss.YouMiao':       '幼苗',
  'gloss.ShengZhang':    '生长',
  'gloss.ZhongZhi':      '种植',
  'gloss.GengDi':        '耕地',
  'gloss.BaoGuo':        '包裹',
  'gloss.BaoXiang':      '宝箱',
  'gloss.DaoJu':         '道具',
  'gloss.RongQi':        '容器',
  'gloss.GuanLiQi':      '管理器',
  'gloss.WenMing':       '文明',
  'gloss.CaiLiao':       '材料',
  'gloss.WuQi':          '武器',
  'gloss.Wuqi':          '武器',
  'gloss.FangJu':        '防具',
  'gloss.ZhuangBei':     '装备',
  'gloss.JiNeng':        '技能',
  'gloss.YuanXing':      '原型',
  'gloss.QiTa':          '其他',
  'gloss.GongZuoTai':    '工作台',
  'gloss.JiaJu':         '家具',
  'gloss.FengChe':       '风车',
  'gloss.ChuanSongMen':  '传送门',
};
