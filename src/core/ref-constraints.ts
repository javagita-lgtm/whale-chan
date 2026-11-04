/**
 * 参考图生图的约束词（提炼自 gen-ai-pose-image / 澜姿）。
 *
 * ## ⚠️ 当前状态：预留模块，尚未接入主流程
 *
 * 本模块逻辑完整、有测试覆盖，但**机器人实际生图时不会用到**——
 * 因为 `ImageRequest.refImages` 没有任何调用方传入
 * （详见 `image-gen.ts` 里该字段的注释）。
 *
 * 等硬件升级、决定做多图参考生图时，按 `image-gen.ts` 注释里的
 * 三步接通即可，本模块不用改。
 *
 * ## 为什么单独建这个模块
 *
 * 多图参考（角色 + 服装 + 姿势 + 脸部）最容易翻车的不是"画不出来"，
 * 而是**画多了**——模型会：
 *   - 把姿势线稿的关节圆、比例辅助线一起画进去
 *   - 把服装图里的人台/假人/空白身体画进去
 *   - 把脸部参考图的衣服/背景/画框带过来
 *   - 把多张参考图的脸混在一起，变成另一张脸
 *
 * 单靠负面词表（`worst quality, bad anatomy` 那类）解决不了这些，
 * 必须在**正向提示词里写明确的"不要做什么"**。这是澜姿项目
 * `shared/prompt.mjs` 里最值钱的部分，这里提炼成可复用常量。
 *
 * 来源：https://github.com/wzc520pyfm/gen-ai-pose-image（MIT，程序部分）
 * 只借鉴提示词写法，不依赖其代码与素材。
 */

/**
 * 姿势线稿的约束。
 *
 * 关键：线稿只提供**姿态**，不是画面内容。
 * 不写这几句时，模型大概率把骨架球、辅助线画进成图。
 */
export const POSE_CONSTRAINTS = [
  '只从线稿提取身体姿态、重心、四肢位置和镜头角度',
  '不要把线稿、关节圆、比例辅助线画进成图',
] as const;

/**
 * 服装参考的约束。
 *
 * 服装库里通常是**没有人物的衣服平铺图或人台图**，
 * 模型会把人台也画进去。
 */
export const COSTUME_CONSTRAINTS = [
  '服装参考图只有衣服，没有人物',
  '把角色换成这套衣服，包括颜色、层次、鞋袜和配饰',
  '不要画出服装图里的人台、假人或空白身体',
] as const;

/**
 * 脸部参考的约束。
 *
 * 最容易出错的一条：脸部参考图里**没有**角色的标志性特征
 * （耳朵/角/尾巴），模型会因此把它们一起去掉。
 */
export function faceConstraints(features: string): readonly string[] {
  return [
    '把脸部参考图只当作脸部和表情参考：五官、脸型、骨相、表情和发型与它一致',
    '不要把脸部参考图里的衣服、身体、背景或画框画进成图',
    features
      ? `角色参考里已有的${features}仍然保留，不要因为脸部参考里没有就去掉`
      : '角色参考里已有的耳朵、角或尾巴仍然保留，不要因为脸部参考里没有就去掉',
  ];
}

/** 「保持原服装」的约束。 */
export const KEEP_OUTFIT_CONSTRAINTS = [
  '必须保留角色参考图中的服装、发色、发型和配饰',
  '衣服保持参考图里已经穿好的完整日常外衣，不要照抄线稿的空白身体',
] as const;

/** 通用收尾（避免水印/文字/画框）。 */
export const OUTPUT_CONSTRAINTS = [
  '不要水印，不要文字，不要画框外的说明',
] as const;

/** 角色一致性（多姿势时防止角色漂移）。 */
export const IDENTITY_CONSTRAINTS = [
  '所有姿势必须是同一位角色，脸、发型、发色、体型完全一致',
  '这是成年人物，脸和身体都用成人比例',
] as const;

/**
 * 把多组约束拼成一段提示词。
 *
 * @param groups 约束组（每个元素是一组 readonly string[]）
 * @returns 用换行分隔的完整约束段
 *
 * @example
 * ```ts
 * composeConstraints([
 *   POSE_CONSTRAINTS,
 *   COSTUME_CONSTRAINTS,
 *   OUTPUT_CONSTRAINTS,
 * ])
 * ```
 */
export function composeConstraints(groups: ReadonlyArray<readonly string[]>): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const g of groups) {
    for (const line of g) {
      if (seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
    }
  }
  return lines.join('\n');
}

/**
 * 根据本次请求用了哪些参考图，自动选出需要的约束。
 *
 * 这个函数是给调用方偷懒用的——不用手工记得"有姿势图就要加 POSE 约束"。
 */
export function constraintsForRefs(refs: {
  hasPose?: boolean;
  hasCostume?: boolean;
  hasFace?: boolean;
  keepOutfit?: boolean;
  features?: string;
}): string {
  const groups: Array<readonly string[]> = [];
  if (refs.hasPose) groups.push(POSE_CONSTRAINTS);
  if (refs.hasCostume) groups.push(COSTUME_CONSTRAINTS);
  if (refs.hasFace) groups.push(faceConstraints(refs.features ?? ''));
  if (refs.keepOutfit) groups.push(KEEP_OUTFIT_CONSTRAINTS);
  groups.push(OUTPUT_CONSTRAINTS);
  return composeConstraints(groups);
}
