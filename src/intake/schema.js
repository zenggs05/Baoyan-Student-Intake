// 学员信息采集 · 表单结构
// 逐项移植自原版打包代码（O6 / On / g6 / $3 / R7 / d5 / s0 / X3）。
// ⚠️ 模块 key、字段 id、选项文字都是 localStorage 草稿与 JSON 备份的数据格式，
//    改动会导致老学员的草稿无法读取。只能改 label 以外的展示逻辑时请三思。

export const SCHEMA_VERSION = '1.0.0';
export const FORM_TYPE = 'baoyan-student-intake';

/** 「待确认」标记（原版常量 G0） */
export const PENDING = '待确认';
export const NOT_APPLICABLE = '不适用';
export const UNTAKEN = '未考';

const MIN_YEAR = 1980;
export const maxYear = () => new Date().getFullYear() + 15;

/** 通用字段构造（原版 g6） */
const field = (id, label, type = 'text', extra = {}) => ({
  id,
  label,
  type,
  required: false,
  hint: `请填写${label}；不确定可标记待确认。`,
  maxLength: type === 'textarea' ? 6000 : 300,
  ...extra,
});
const text = (id, label, extra) => field(id, label, 'text', extra); // $3
const longText = (id, label, extra) => field(id, label, 'textarea', extra); // R7
const number = (id, label, min, max, extra) => field(id, label, 'number', { min, max, ...extra }); // d5
const year = (id, label, extra) => number(id, label, MIN_YEAR, maxYear(), { integer: true, ...extra }); // s0
const select = (id, label, options, extra) => field(id, label, 'select', { options, ...extra }); // X3

const YES_NO = ['是', '否'];
const DEGREE_OPTIONS = ['学硕', '专硕', '直博', '多种都考虑', '尚未确定'];

/** 六个填写步骤（原版 On） */
export const STEPS = [
  { title: '基本信息', short: '认识你', description: '从你的本科背景开始，建立专属于你的申请档案。' },
  { title: '学业与推免资格', short: '了解基础', description: '区分学业排名与综合测评，帮助我们准确理解你的起点。' },
  { title: '英语与科研经历', short: '发现潜力', description: '记录真实的能力与投入。没有科研经历，也可以从这里开始。' },
  { title: '论文、竞赛与荣誉', short: '梳理积累', description: '每一项经历都值得认真梳理，请突出你实际承担的工作。' },
  { title: '升学目标与偏好', short: '明确方向', description: '学校之外，也聊聊你想研究什么、期待怎样的成长。' },
  { title: '时间安排与辅导需求', short: '准备出发', description: '让接下来的计划适合你的时间、节奏和真实需求。' },
];

/** 全部模块（原版 O6）。repeat:true 表示可重复的经历条目。 */
export const SECTIONS = [
  {
    key: 'student', step: 0, title: '基本信息',
    description: '称呼即可，无需填写证件号码、学号或家庭住址。',
    fields: [
      text('displayName', '希望如何称呼', { required: true, hint: '填写你习惯的称呼或昵称。', maxLength: 80 }),
      text('university', '本科高校', { required: true, hint: '建议填写学校全称，方便准确识别。' }),
      text('college', '所在学院', { required: true }),
      text('major', '当前专业', { required: true }),
      text('specialClass', '是否为实验班、创新班等', { hint: '如有，请写明班型；没有可填写“否”。' }),
      year('enrollmentYear', '本科入学年份', { required: true }),
      select('grade', '当前年级', ['大一', '大二', '大三', '大四', '大五及以上', '已毕业'], { required: true }),
      year('applicationYear', '预计推免申请年份', { required: true, hint: '指参加夏令营、预推免的年份。' }),
      year('graduateEnrollmentYear', '预计研究生入学年份', { required: true }),
      field('formDate', '填写日期', 'date', { required: true, hint: '默认今天，可按实际情况修改。' }),
      longText('mainQuestion', '当前最希望解决的问题', { required: true, hint: '例如：不确定推免资格、如何选择方向、如何规划科研。' }),
      longText('notes', '个人情况补充说明'),
    ],
  },
  {
    key: 'academics', step: 1, title: '学业成绩',
    description: '两类排名分别记录；没有该项排名时请选择“不适用”。',
    fields: [
      number('gpa', '当前 GPA', 0, 100, { required: true }),
      number('gpaScale', 'GPA 满分', 0.1, 100, { required: true, hint: '例如 4、4.3 或 5；请与当前 GPA 使用同一计分制。' }),
      number('academicRank', '学业成绩排名', 1, 100000, { integer: true, required: true }),
      number('academicTotal', '专业总人数', 1, 100000, { integer: true, required: true }),
      number('comprehensiveRank', '综合测评排名', 1, 100000, { integer: true, required: true, allowNA: true }),
      number('comprehensiveTotal', '综合测评总人数', 1, 100000, { integer: true, required: true, allowNA: true }),
      text('rankSemester', '排名统计截至哪个学期', { required: true, hint: '例如：大二下学期；请注明排名统计范围。' }),
      select('rankSource', '排名依据', ['官方证明', '教务系统', '个人估算'], { required: true }),
      longText('coreCourses', '相关核心课程及成绩'),
      select('trend', '近期成绩变化', ['上升', '稳定', '下降', '不确定']),
      longText('failedCourses', '是否存在挂科或重修', { hint: '无则填“无”；如有，请说明科目、时间与处理情况。' }),
      longText('notes', '成绩情况补充说明'),
    ],
  },
  {
    key: 'recommendationEligibility', step: 1, title: '推免资格',
    description: '以本校最新公开政策为准；尚不了解的内容可以标记待确认。',
    fields: [
      field('policyUrl', '学校最近一年推免政策链接', 'url', { required: true }),
      text('previousQuota', '学院往年推免名额', { required: true, hint: '请写明年份、专业和名额；不了解可标记待确认。' }),
      longText('rules', '已知推免评定规则', { required: true }),
      longText('weights', '成绩和创新成果在评定中的权重'),
      longText('specialConditions', '特殊推免条件'),
      select('likelihood', '自评取得推免资格的可能性', ['比较稳妥', '有竞争', '风险较大', '无法判断'], { required: true }),
      longText('mainRisk', '当前最大的资格风险', { required: true }),
      longText('questions', '仍需核实的政策问题'),
    ],
  },
  {
    key: 'english', step: 2, title: '英语能力',
    description: '未参加的考试可以选择“未考”，不必编造分数。',
    fields: [
      number('cet4', 'CET-4 分数', 0, 710, { integer: true, required: true, allowUntaken: true }),
      field('cet4Date', 'CET-4 考试时间', 'month'),
      number('cet6', 'CET-6 分数', 0, 710, { integer: true, required: true, allowUntaken: true }),
      field('cet6Date', 'CET-6 考试时间', 'month'),
      longText('otherScores', 'IELTS / TOEFL 等其他英语成绩', { hint: '注明考试名称、分数和考试时间。' }),
      text('validUntil', '英语成绩有效期'),
      select('selfIntroduction', '英文自我介绍能力自评', ['流畅完成', '基本完成', '需要强化', '未评估']),
      select('interview', '英语面试交流能力自评', ['能流畅交流', '能进行基础问答', '需要强化', '未评估'], { required: true }),
      select('reading', '英文文献阅读能力自评', ['熟练', '基本可以', '需要字典辅助', '刚开始'], { required: true }),
      longText('difficulties', '英语学习方面的主要困难'),
    ],
  },
  {
    key: 'researchProjects', step: 2, title: '科研经历',
    description: '写清研究问题、实际贡献与结果。可按重要程度调整顺序。',
    repeat: true, itemName: '科研项目',
    fields: [
      text('name', '项目名称', { required: true }),
      text('direction', '研究方向'),
      text('period', '起止时间'),
      text('organization', '参与单位或课题组'),
      text('role', '个人担任的角色'),
      longText('background', '研究背景和主要问题'),
      longText('contribution', '本人实际承担的工作', { required: true }),
      longText('methods', '研究方法、软件、实验或算法'),
      longText('outcomes', '取得的阶段成果'),
      text('status', '成果当前状态'),
      longText('evidence', '可分享的证明材料或公开链接', { hint: '仅填写公开信息；请勿包含涉密内容。' }),
      longText('strength', '最能体现研究能力的部分'),
      longText('challenges', '主要困难及解决方法'),
    ],
  },
  {
    key: 'publications', step: 3, title: '论文',
    description: '请严格区分已发表、已接收与在投，状态不会预先选择。',
    repeat: true, itemName: '论文',
    fields: [
      text('title', '论文标题', { required: true }),
      text('venue', '期刊或会议名称'),
      year('year', '年份'),
      text('authorOrder', '作者顺序'),
      select('coFirstAuthor', '是否共同第一作者', YES_NO),
      select('status', '发表状态', ['已发表', '已接收', '在投', '预印本', '准备中'], { required: true }),
      text('doi', 'DOI 或公开链接'),
      longText('contribution', '本人实际贡献', { required: true }),
    ],
  },
  {
    key: 'achievements', step: 3, title: '其他学术成果',
    description: '无相关成果可留空或填写“暂无”。',
    fields: [
      longText('otherAcademic', '专利、软件著作权、开源项目及其他成果', { hint: '注明名称、状态、本人贡献；也可记录报告、海报、开放数据。' }),
    ],
  },
  {
    key: 'competitions', step: 3, title: '竞赛与荣誉记录',
    description: '按实际参与情况填写，个人贡献比罗列奖项更有帮助。',
    repeat: true, itemName: '竞赛或荣誉',
    fields: [
      text('name', '比赛或荣誉名称', { required: true }),
      year('year', '参加年份'),
      text('organizer', '主办单位或竞赛级别'),
      text('award', '获奖等级'),
      text('role', '个人角色'),
      longText('responsibilities', '具体负责工作'),
      longText('outcomes', '竞赛成果'),
      longText('evidence', '可核实的证书或链接'),
    ],
  },
  {
    key: 'experience', step: 3, title: '更多经历与个人优势',
    description: '从经历中发现你独特的积累。',
    fields: [
      longText('scholarships', '奖学金和其他荣誉'),
      longText('activities', '学生工作、社会实践和相关实习经历'),
      longText('topStrengths', '最有代表性的三项优势'),
      longText('bestExperience', '最能体现个人能力的一段经历', { hint: '可按“背景—我做了什么—结果—收获”展开。' }),
    ],
  },
  {
    key: 'careerGoals', step: 4, title: '升学与职业目标',
    description: '允许探索和变化，请按当前真实想法填写。',
    fields: [
      select('degree', '研究生学位倾向', DEGREE_OPTIONS, { required: true }),
      select('crossMajor', '是否考虑跨专业', ['是', '否', '视方向而定']),
      longText('directions', '意向学科方向', { required: true }),
      longText('excludedDirections', '明确不考虑的研究方向'),
      select('futureGoal', '未来发展目标', ['读博', '就业', '考公 / 事业单位', '创业', '其他', '未确定'], { required: true }),
      select('overseas', '是否考虑未来出国深造', ['是', '否', '尚未确定']),
      longText('interests', '感兴趣的科研与职业领域'),
      select('researchStyle', '研究与实践倾向', ['理论研究', '应用研究', '工程实践', '均可']),
      longText('supervisorStyle', '导师培养方式偏好'),
      longText('labCulture', '课题组工作节奏及氛围期望'),
      text('preferredRegions', '地域偏好'),
      text('excludedRegions', '无法接受的城市或地区'),
      longText('constraints', '其他重要现实限制'),
      select('riskPreference', '申请风险态度', ['冲刺', '稳妥', '均衡'], { required: true }),
      longText('futureSelf', '期待三年或五年后成为怎样的人'),
    ],
  },
  {
    key: 'targetPrograms', step: 4, title: '目标院校与导师',
    description: '可以先记录初步意向，再逐步补充学院、方向与导师。',
    repeat: true, itemName: '目标院校',
    fields: [
      text('university', '学校名称', { required: true }),
      text('college', '学院名称'),
      text('major', '专业名称'),
      text('direction', '具体研究方向'),
      select('degree', '学位意向', DEGREE_OPTIONS),
      text('supervisor', '感兴趣的导师'),
      field('website', '导师主页或项目官网链接', 'url'),
      longText('reason', '感兴趣的原因'),
      select('familiarity', '当前了解程度', ['初步听说', '已查阅官网', '深入了解', '已联系沟通']),
    ],
  },
  {
    key: 'targetPreferences', step: 4, title: '择校考虑',
    description: '没有最终名单也没关系，先梳理最看重的条件。',
    fields: [
      longText('topThree', '最想申请的 3 所高校', { required: true }),
      select('contacted', '是否已经联系导师', ['是', '否']),
      longText('factors', '最在意的择校因素及排序', { required: true }),
      longText('nonNegotiables', '一定不能放弃的升学条件'),
    ],
  },
  {
    key: 'availability', step: 5, title: '时间安排',
    description: '合理评估可投入的时间，帮助形成可执行的计划。',
    fields: [
      number('weeklyHours', '每周可投入的准备时间（小时）', 0, 168, { required: true }),
      longText('termAndVacation', '学期中与假期的可投入时间'),
      longText('upcomingTasks', '未来三个月的重要考试或任务'),
      longText('upcomingPlans', '未来三个月科研、竞赛或实习计划'),
    ],
  },
  {
    key: 'supportNeeds', step: 5, title: '辅导需求',
    description: '从你最需要帮助的地方开始。',
    fields: [
      longText('topProblems', '当前最重要的三个问题', { required: true }),
      field('priorities', '最希望优先得到的帮助', 'multiselect', {
        required: true,
        options: ['资格诊断', '择校分析', '科研规划', '英语提升', '申请材料', '面试准备', '其他'],
        hint: '可多选；如选择其他，请在目标中说明。',
      }),
      text('frequency', '理想的交流频率'),
      longText('goals', '希望通过全程陪跑实现的目标'),
    ],
  },
  {
    key: 'materials', step: 5, title: '可选材料清单',
    description: '这里只记录清单，不上传文件。后续私发材料前，请遮挡无关个人信息。',
    fields: [
      field('available', '已准备的材料', 'multiselect', {
        options: ['本校最新推免政策链接', '成绩排名证明', '英语成绩证明', '个人简历', '公开科研项目介绍', '已公开论文信息', '竞赛证书', '目标院校招生通知', '其他相关材料'],
        hint: '请勿提供身份证号、家庭住址、银行卡信息或涉密科研资料。',
      }),
      longText('notes', '材料补充说明与公开链接'),
    ],
  },
  {
    key: 'confirmation', step: 5, title: '信息确认',
    description: '导出的档案需要由你主动私发给辅导老师，网页不会自动提交资料。',
    fields: [
      field('truthful', '我已尽可能如实填写上述信息', 'checkbox', { required: true, hint: '未知信息可以标记待确认，无经历请如实说明。' }),
      field('understandsLimit', '我了解院校定位分析不代表录取保证', 'checkbox', { required: true, hint: '建议基于现有材料及当年公开招生政策。' }),
      text('signedName', '填写人称呼', { required: true, hint: '称呼或昵称即可，无需身份证明。', maxLength: 80 }),
    ],
  },
];

export const SECTION_BY_KEY = Object.fromEntries(SECTIONS.map((s) => [s.key, s]));
