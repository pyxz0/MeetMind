import { Test, TestingModule } from '@nestjs/testing';
import { AiService } from './ai.service';
import { PrismaService } from '../common/prisma.service';

// AiService 构造时会用 API Key 初始化 OpenAI 客户端，测试里给一个占位值
process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'sk-test-placeholder';

describe('AiService', () => {
  let service: AiService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiService,
        // AiService 依赖 Prisma，测试里只关心装配是否成功
        { provide: PrismaService, useValue: {} },
      ],
    }).compile();

    service = module.get<AiService>(AiService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});