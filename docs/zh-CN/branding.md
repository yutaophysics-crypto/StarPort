# 星港的主标识与主题顺序

[English](../branding.md) | 简体中文

星港在应用外的标识是 `public/icon.svg` 中蔚蓝主题的「星光与海浪」。桌面快捷方式、手机 PWA 安装图标、仓库标识和其他应用外的素材都使用它。

在应用内，侧栏标识和网页图标跟随所选主题：蔚蓝使用 `public/icon.svg`，星港使用 `public/assets/spaceport-icon.svg`，深空使用 `public/assets/deep-space-icon.svg`。已安装应用的图标保持蔚蓝标识。

主题顺序是 **蔚蓝 → 星港 → 深空**。没有保存的选择时默认蔚蓝；已有的选择会保留。

这条顺序表达星港的愿景：陪伴人类文明从蔚蓝走向星港时代（星际文明），再走向深空时代（宇宙文明）。

`scripts/build-brand-icons.mjs` 从蔚蓝 SVG 生成 Windows ICO 和手机安装图标。新增应用外的入口时复用这份素材；应用内保留每个主题各自的图标、背景和装饰。
