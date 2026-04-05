// server/server.js
import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const wordsPath = path.join(__dirname, 'words.json');
const wordsData = JSON.parse(fs.readFileSync(wordsPath, 'utf8'));

const app = express();
app.use(cors({
  origin: process.env.FRONTEND_URL || "*",
  credentials: true
}));

const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "*", 
    methods: ["GET", "POST"],
    credentials: true 
  }
});



app.use(express.json())

app.post('/api/token', async (req, res) => {
  const response = await fetch(`https://discord.com/api/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: req.body.code,
    }),
  });
  
  const { access_token } = await response.json();
  res.send({ access_token });
});

let gameSession = {
  participantsCount: 0,
  readyCount: 0,
  turnOrder: [],
  currentIndex: 0,
  currentRound: 1,
  totalRounds: 2,
  timeLimit: 15,
  discussionTime: 30,
  timerId: null,
  discussionEndVotes: 0,
  votes: {}, // {voterId: targetId}
  liarId: null,
  selectedPair: null,
  voteCandidates: []
};

const socketUserMap = {};

io.on('connection', (socket) => {
  socket.on('register_player', (data) => {
    socketUserMap[socket.id] = data.userId;
    console.log(`✅ 출석부 등록: 소켓(${socket.id}) -> 유저(${data.userId})`);
  });

  socket.on('join_signal', () => {
    io.emit('must_refresh_participants');
  });

  const shuffleTurns = () => {
    const shuffled = [...gameSession.participants].sort(() => Math.random() - 0.5);
    gameSession.turnOrder = shuffled.map(p => (p.participant || p.user || p).id);
  };

  socket.on('start_game', (data) => {
    try {
      const { participants, rounds, timeLimit, discussionTime } = data;
      if (!participants || participants.length === 0) return;

      const currentWordList = wordsData[language] || wordsData["English"];

      gameSession.participants = participants;
      gameSession.participantsCount = participants.length;
      gameSession.totalRounds = rounds;
      gameSession.timeLimit = timeLimit;
      gameSession.discussionTime = discussionTime;
      gameSession.readyCount = 0;
      gameSession.currentIndex = 0;
      gameSession.currentRound = 1;

      const selectedPair = currentWordList[Math.floor(Math.random() * currentWordList.length)];
      const liarIndex = Math.floor(Math.random() * participants.length);
      const liar = participants[liarIndex].participant || participants[liarIndex].user || participants[liarIndex];
      
      gameSession.liarId = liar.id;
      gameSession.selectedPair = selectedPair;
      
      shuffleTurns();

      io.emit('start_loading');
      setTimeout(() => {
        io.emit('roles_assigned', {
          liarId: gameSession.liarId,
          category: selectedPair.category,
          word: selectedPair.word,
          turnOrder: gameSession.turnOrder
        });
      }, 3000);
    } catch (error) { console.error(error); }
  });

  socket.on('player_ready', () => {
    gameSession.readyCount++;
    if (gameSession.readyCount === gameSession.participantsCount) {
      startTurn();
    }
  });

  const startTurn = () => {
    clearTimeout(gameSession.timerId);
    const currentSpeaker = gameSession.turnOrder[gameSession.currentIndex];

    io.emit('turn_sync', {
      speakerId: currentSpeaker,
      round: gameSession.currentRound,
      totalRounds: gameSession.totalRounds,
      timeLimit: gameSession.timeLimit,
      isDiscussion: false
    });

    gameSession.timerId = setTimeout(() => {
      handleEndTurn();
    }, gameSession.timeLimit * 1000);
  };

  const handleEndTurn = () => {
    clearTimeout(gameSession.timerId);
    gameSession.currentIndex++;

    if (gameSession.currentIndex >= gameSession.participantsCount) {
      startOpenDiscussion();
    } else {
      startTurn();
    }
  };

  // 전체 토론 시간
  const startOpenDiscussion = () => {
    gameSession.discussionEndVotes = 0;
    
    io.emit('turn_sync', {
      speakerId: 'ALL',
      round: gameSession.currentRound,
      totalRounds: gameSession.totalRounds,
      timeLimit: gameSession.discussionTime, // 위에서 저장한 설정값이 들어갑니다.
      isDiscussion: true
    });

    gameSession.timerId = setTimeout(() => {
      endDiscussionPhase();
    }, gameSession.discussionTime * 1000);
  };

  const endDiscussionPhase = () => {
    clearTimeout(gameSession.timerId);
    gameSession.currentRound++;
    
    if (gameSession.currentRound > gameSession.totalRounds) {
      const allIds = gameSession.participants.map(p => (p.participant || p.user || p).id);
      startVotingPhase(allIds);
    } else {
      shuffleTurns();
      gameSession.currentIndex = 0;
      startTurn();
    }
  };

  const startVotingPhase = (candidates) => {
    gameSession.votes = {};
    gameSession.voteCandidates = candidates;
    io.emit('start_voting', { candidates, timeLimit: 15 });

    clearTimeout(gameSession.timerId);
    gameSession.timerId = setTimeout(() => {
      calculateResult();
    }, 15 * 1000);
  };

  socket.on('submit_vote', (data) => {
    const { voterId, targetId } = data;
    gameSession.votes[voterId] = targetId;
    io.emit('update_vote_count', { votedCount: Object.keys(gameSession.votes).length });

    if (Object.keys(gameSession.votes).length === gameSession.participantsCount) {
      calculateResult();
    }
  });

  const calculateResult = () => {
    clearTimeout(gameSession.timerId);
    const voteCounts = {};
    gameSession.voteCandidates.forEach(id => voteCounts[id] = 0);
    Object.values(gameSession.votes).forEach(id => { voteCounts[id] += 1; });

    if (Object.keys(gameSession.votes).length === 0) {
      io.emit('game_over', { isLiarCaught: false, liarId: gameSession.liarId, word: gameSession.selectedPair.word });
      return;
    }

    const maxVotes = Math.max(...Object.values(voteCounts));
    const tiedIds = Object.keys(voteCounts).filter(id => voteCounts[id] === maxVotes);

    if (tiedIds.length === 1) {
      const isLiarCaught = tiedIds[0] === gameSession.liarId;
      
      if (isLiarCaught) {
        io.emit('liar_last_chance', { liarId: gameSession.liarId, category: gameSession.selectedPair.category });
      } else {
        io.emit('game_over', { isLiarCaught: false, liarId: gameSession.liarId, mostVotedId: tiedIds[0], word: gameSession.selectedPair.word });
      }
    } else {
      io.emit('tie_breaker_speech', { candidates: tiedIds, timeLimit: 30 });
      gameSession.timerId = setTimeout(() => { startVotingPhase(tiedIds); }, 30 * 1000);
    }
  };

  socket.on('vote_end_discussion', () => {
    gameSession.discussionEndVotes++;
    
    io.emit('update_discussion_votes', { votes: gameSession.discussionEndVotes });

    if (gameSession.discussionEndVotes >= gameSession.participantsCount) {
      endDiscussionPhase();
    }
  });

  socket.on('end_turn', handleEndTurn);

  socket.on('join_signal', () => {
    io.emit('must_refresh_participants');
  });

  socket.on('submit_liar_guess', (data) => {
    const { guess } = data;
    const isCorrect = guess.trim() === gameSession.selectedPair.word.trim();

    io.emit('game_over', {
      isLiarCaught: !isCorrect,
      liarId: gameSession.liarId,
      word: gameSession.selectedPair.word,
      liarGuess: guess,
      isLiarCorrect: isCorrect
    });
  });

  socket.on('disconnect', () => {
    const leftUserId = socketUserMap[socket.id];
    
    if (leftUserId) {
      console.log(`🔴 유저 완벽 퇴장 감지: ${leftUserId}`);
      io.emit('player_left', { userId: leftUserId }); 
      delete socketUserMap[socket.id]; // 출석부에서 삭제

      if (gameSession.participantsCount > 0) {
        gameSession.participants = gameSession.participants.filter(p => {
          const pId = p.participant?.id || p.user?.id || p.id;
          return pId !== leftUserId;
        });
        gameSession.participantsCount = gameSession.participants.length;

        if (leftUserId === gameSession.liarId) {
          console.log('🚨 라이어 도주! 게임을 강제 종료합니다.');
          clearTimeout(gameSession.timerId);
          io.emit('game_over', {
            isLiarCaught: true, 
            liarId: gameSession.liarId,
            word: gameSession.selectedPair?.word,
            reason: 'LIAR_FLED'
          });
          return;
        }

        const currentSpeakerId = gameSession.turnOrder[gameSession.currentIndex];
        if (leftUserId === currentSpeakerId && gameSession.timerId) {
          console.log('🚨 현재 발언자 탈주! 다음 사람으로 턴을 넘깁니다.');
          handleEndTurn(); 
        }

        gameSession.turnOrder = gameSession.turnOrder.filter(id => id !== leftUserId);
        gameSession.voteCandidates = gameSession.voteCandidates.filter(id => id !== leftUserId);
      }
    }
  });

  socket.on('return_to_lobby', () => {
    console.log('🔄 게임 리셋 요청 수신! 대기실로 돌아갑니다.');
    
    // 혹시라도 돌아가고 있는 타이머가 있다면 확실하게 정지
    clearTimeout(gameSession.timerId);

    // 다음 게임을 위해 세션 데이터 초기화 (참가자 설정 제외)
    gameSession.readyCount = 0;
    gameSession.turnOrder = [];
    gameSession.currentIndex = 0;
    gameSession.currentRound = 1;
    gameSession.discussionEndVotes = 0;
    gameSession.votes = {};
    gameSession.liarId = null;
    gameSession.selectedPair = null;
    gameSession.voteCandidates = [];

    // 모든 클라이언트에게 "전원 로비로 집합!" 명령 하달
    io.emit('game_reset');
  });
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`🚀 백엔드 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});