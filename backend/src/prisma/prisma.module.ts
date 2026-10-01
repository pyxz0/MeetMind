import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

// 全局导出 PrismaService，业务模块可直接注入同一个数据库客户端。
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
