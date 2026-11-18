// 内核 · 服务端配置
// 所有对外地址集中在这里，便于换源 / 自建后端 / 离线演示。
// 每一项都可以用环境变量覆盖，不需要改代码。
'use strict';

function env(k, dflt) {
  const v = process.env[k];
  return (v === undefined || v === '') ? dflt : v;
}

/* 业务 API 根（不带结尾斜杠） */
const API_BASE = env('ZHIBO_API_BASE', 'https://api.zhibojiaoyu.cn/api');

/* 客户端应用标识。这是**每个客户端都一样的公开常量**，不是任何人的账号票据；
 * 真正的用户票据只能来自登录响应，绝不写进代码。 */
const APP_TOKEN = env('ZHIBO_APP_TOKEN', '3da38adb08094d26bffe558da29066f4');

/* 图片防盗链用的 Referer */
const IMAGE_REFERER = env('ZHIBO_IMAGE_REFERER', 'https://www.zhibojiaoyu.cn/');

module.exports = { API_BASE, APP_TOKEN, IMAGE_REFERER };
