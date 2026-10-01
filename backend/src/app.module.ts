import { Module } from '@nestjs/common'

import { ConfigModule } from '@nestjs/config'

import { AppController } from './app.controller'

import { AppService } from './app.service'

import { AiModule } from './ai/ai.module'

import { PrismaModule } from './common/prisma.module'

@Module({

  imports: [

    ConfigModule.forRoot({

      isGlobal: true,

    }),

    PrismaModule,

    AiModule,

  ],

  controllers: [AppController],

  providers: [AppService],

})

export class AppModule {}