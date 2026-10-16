
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { AppModule } from './app.module'

/** 录音文件的存放目录，与 MeetingAudioService 使用同一规则。 */
const UPLOAD_DIR = join(process.cwd(), 'uploads')

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule)

  app.setGlobalPrefix('api')

  app.enableCors()

  // 首次启动时创建录音目录，避免静态资源服务指向不存在的路径。
  mkdirSync(UPLOAD_DIR, { recursive: true })

  /**
   * 直接把录音暴露在 /uploads 下。
   *
   * 用 Express 的静态资源服务而不是自己实现流式接口，
   * 因为它已经正确处理了 Range 请求——这是音频播放器拖动进度条
   * 跳转所必需的，手写很容易漏掉。
   */
  app.useStaticAssets(UPLOAD_DIR, {
    prefix: '/uploads/',
    // 录音体积较大，让浏览器缓存一天，回听时不必重复下载。
    maxAge: '1d',
  })

  await app.listen(3000)
}

bootstrap()
