import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  /** 使用 pg 驱动适配器连接 PostgreSQL，启动时明确要求提供连接串。 */
  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error('DATABASE_URL is required');
    }

    super({ adapter: new PrismaPg({ connectionString }) });
  }

  /** Nest 模块启动时建立数据库连接，连接失败会阻止服务误报为可用。 */
  async onModuleInit() {
    await this.$connect();
  }

  /** Nest 模块退出时释放 Prisma 和 pg 连接资源。 */
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
