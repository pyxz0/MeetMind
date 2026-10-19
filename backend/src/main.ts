
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

  // 首次启动时创建录音目录，避免写入时目录不存在。
  mkdirSync(UPLOAD_DIR, { recursive: true })

  /**
   * 录音不再通过静态目录公开。
   *
   * 之前用 useStaticAssets 把 uploads 挂在 /uploads 下，
   * 好处是 Express 静态服务天然支持 Range，实现简单；
   * 但「录音是否开放」这个权限就形同虚设 —— 只要知道文件名，
   * 任何人都能直接拿到音频，绕过会议成员与录音开关的限制。
   *
   * 现在统一走 GET /api/meetings/:id/audio，
   * 由守卫与 assertCanListenAudio 校验身份与开关，
   * 再用 res.sendFile 保留 Range 支持（进度条拖动依赖 206）。
   */

  await app.listen(3000)
}

bootstrap()
