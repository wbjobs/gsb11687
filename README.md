# SVG 路径动画实验室

解析 SVG path（M/L/H/V/C/S/Q/T/A/Z），计算长度/切线/法线，实现沿路径运动、路径变形、路径裁剪与控制点可视化编辑。

## 运行

```bash
npm run serve        # python3 -m http.server 8080
# 打开 http://localhost:8080
```

注意：必须通过 HTTP 访问（Web Worker + ES Module 不支持 file:// 直开）。

## 测试

```bash
npm test             # node --test，18 个用例
```

## 功能与验收对照

| 验收标准 | 实现 |
| --- | --- |
| 路径解析正确 | `js/pathParser.js`：全指令、相对/绝对、隐式 L、S/T 反射控制点 |
| 长度/切线/法线正确 | `js/pathGeometry.js`：自适应扁平化 + 累计长度表 + 二分查找 |
| 沿路径运动正确 | `js/animator.js` + `js/main.js`：按弧长匀速运动，三角形朝向切线 |
| 弧线处理正确 | 端点→圆心参数化（SVG F.6.5），半径不足自动放大，rx=0 退化直线 |
| 语法错误提示 | 非法字符/参数不足/负半径/非法标志位，带字符位置 |
| 长路径不卡 | Web Worker 后台扁平化，Transferable 传回，超限截断保护 |
| 动画流畅 | PerformanceObserver 监听 longtask + 帧耗滑窗，自动逐级降级到直线近似 |

## 技术栈

SVG 语法 + Canvas 渲染 + Web Worker + PerformanceObserver + IndexedDB（路径预设持久化）。

## 文件结构

- `index.html` / `css/style.css` — 页面与样式
- `js/pathParser.js` — 词法/语法解析，错误收集
- `js/pathGeometry.js` — 扁平化、长度表、切线/法线、弧线转换、裁剪、变形重采样
- `js/pathWorker.js` — 后台解析与扁平化
- `js/animator.js` — rAF 动画循环、性能监控、自动降级
- `js/storage.js` — IndexedDB 预设存取
- `js/main.js` — UI 粘合、Canvas 渲染、控制点拖拽
- `test/path.test.js` — 解析/几何/裁剪/变形/性能/降级测试
