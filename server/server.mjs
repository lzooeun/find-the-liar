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

app.use(cors({ origin: "*" }));
app.use(express.json());

const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.post('/api/token', async (req, res) => {
  try {
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

    // 1. 데이터를 딱 한 번만 읽어서 data 변수에 담습니다.
    const data = await response.json();

    // 2. 디스코드에서 거절(에러)을 당했다면?
    if (!response.ok) {
      console.error("🚨 디스코드 토큰 발급 실패 원인:", data);
      return res.status(response.status).send(data); // 프론트엔드에도 에러라고 알려줍니다.
    }

    // 3. 성공했다면 토큰만 쏙 빼서 프론트엔드로 보내줍니다!
    res.send({ access_token: data.access_token });

  } catch (error) {
    // 4. 서버 내부에서 뭔가 터졌을 때의 안전장치
    console.error("🚨 서버 에러 발생:", error);
    res.status(500).send({ error: "Internal Server Error" });
  }
});

const activeGames = {}; // { 방번호: { 게임 데이터 } }
const socketUserMap = {}; // 소켓ID -> { userId, roomId }

// 💡 새로운 방이 만들어질 때 쓸 기본 게임 데이터 템플릿
const createNewSession = () => ({
  participants: [], participantsCount: 0, readyCount: 0, turnOrder: [],
  currentIndex: 0, currentRound: 1, totalRounds: 2, timeLimit: 15,
  discussionTime: 30, timerId: null, discussionEndVotes: 0,
  votes: {}, liarId: null, selectedPair: null, voteCandidates: []
});

io.on('connection', (socket) => {
  
  // 1. 유저 출석 및 방(Room) 입장
  socket.on('register_player', (data) => {
    // 프론트에서 넘어온 roomId가 없으면 임시 방(lobby)에 넣습니다.
    const roomId = data.roomId || 'lobby'; 
    
    socketUserMap[socket.id] = { userId: data.userId, roomId: roomId };
    socket.join(roomId); // ⭐️ 소켓을 해당 방에 강제 입장시킵니다!

    // 이 방에 게임 세션이 없다면 새로 하나 만들어줍니다.
    if (!activeGames[roomId]) {
      activeGames[roomId] = createNewSession();
    }
    
    console.log(`✅ 출석부 등록: 소켓(${socket.id}) -> 유저(${data.userId}), 방 번호: ${roomId}`);
  });

  // 💡 공통 헬퍼: 현재 소켓이 속한 방의 게임 데이터를 가져오는 함수
  const getSession = () => {
    const userInfo = socketUserMap[socket.id];
    return userInfo ? activeGames[userInfo.roomId] : null;
  };

  const getRoomId = () => socketUserMap[socket.id]?.roomId;

  socket.on('join_signal', () => {
    const roomId = getRoomId();
    if (roomId) io.to(roomId).emit('must_refresh_participants'); // ⭐️ 해당 방 사람들에게만 전송!
  });

  const shuffleTurns = (session) => {
    const shuffled = [...session.participants].sort(() => Math.random() - 0.5);
    session.turnOrder = shuffled.map(p => (p.participant || p.user || p).id);
  };

  // 2. 게임 시작
  socket.on('start_game', (data) => {
    const roomId = getRoomId();
    const session = getSession();
    if (!roomId || !session) return;

    try {
      const { participants, rounds, timeLimit, discussionTime, language } = data;
      if (!participants || participants.length === 0) return;

      const currentWordList = wordsData[language || "English"] || wordsData["English"];

      session.participants = participants;
      session.participantsCount = participants.length;
      session.totalRounds = rounds;
      session.timeLimit = timeLimit;
      session.discussionTime = discussionTime;
      session.readyCount = 0;
      session.currentIndex = 0;
      session.currentRound = 1;

      const selectedPair = currentWordList[Math.floor(Math.random() * currentWordList.length)];
      const liarIndex = Math.floor(Math.random() * participants.length);
      const liar = participants[liarIndex].participant || participants[liarIndex].user || participants[liarIndex];
      
      session.liarId = liar.id;
      session.selectedPair = selectedPair;
      
      shuffleTurns(session);

      io.to(roomId).emit('start_loading');
      setTimeout(() => {
        io.to(roomId).emit('roles_assigned', {
          liarId: session.liarId,
          category: selectedPair.category,
          word: selectedPair.word,
          turnOrder: session.turnOrder
        });
      }, 3000);
    } catch (error) { console.error(error); }
  });

  socket.on('player_ready', () => {
    const roomId = getRoomId();
    const session = getSession();
    if (!session) return;

    session.readyCount++;
    if (session.readyCount === session.participantsCount) {
      startTurn(roomId, session);
    }
  });

  // 💡 아래 함수들은 방 번호(roomId)와 세션(session)을 넘겨받아 동작합니다.
  const startTurn = (roomId, session) => {
    clearTimeout(session.timerId);
    const currentSpeaker = session.turnOrder[session.currentIndex];

    io.to(roomId).emit('turn_sync', {
      speakerId: currentSpeaker,
      round: session.currentRound,
      totalRounds: session.totalRounds,
      timeLimit: session.timeLimit,
      isDiscussion: false
    });

    session.timerId = setTimeout(() => {
      handleEndTurn(roomId, session);
    }, session.timeLimit * 1000);
  };

  const handleEndTurn = (roomId, session) => {
    clearTimeout(session.timerId);
    session.currentIndex++;

    if (session.currentIndex >= session.participantsCount) {
      startOpenDiscussion(roomId, session);
    } else {
      startTurn(roomId, session);
    }
  };

  const startOpenDiscussion = (roomId, session) => {
    session.discussionEndVotes = 0;
    
    io.to(roomId).emit('turn_sync', {
      speakerId: 'ALL',
      round: session.currentRound,
      totalRounds: session.totalRounds,
      timeLimit: session.discussionTime,
      isDiscussion: true
    });

    session.timerId = setTimeout(() => {
      endDiscussionPhase(roomId, session);
    }, session.discussionTime * 1000);
  };

  const endDiscussionPhase = (roomId, session) => {
    clearTimeout(session.timerId);
    session.currentRound++;
    
    if (session.currentRound > session.totalRounds) {
      const allIds = session.participants.map(p => (p.participant || p.user || p).id);
      startVotingPhase(roomId, session, allIds);
    } else {
      shuffleTurns(session);
      session.currentIndex = 0;
      startTurn(roomId, session);
    }
  };

  const startVotingPhase = (roomId, session, candidates) => {
    session.votes = {};
    session.voteCandidates = candidates;
    io.to(roomId).emit('start_voting', { candidates, timeLimit: 15 });

    clearTimeout(session.timerId);
    session.timerId = setTimeout(() => {
      calculateResult(roomId, session);
    }, 15 * 1000);
  };

  socket.on('submit_vote', (data) => {
    const roomId = getRoomId();
    const session = getSession();
    if (!session) return;

    const { voterId, targetId } = data;
    session.votes[voterId] = targetId;
    io.to(roomId).emit('update_vote_count', { votedCount: Object.keys(session.votes).length });

    if (Object.keys(session.votes).length === session.participantsCount) {
      calculateResult(roomId, session);
    }
  });

  const calculateResult = (roomId, session) => {
    clearTimeout(session.timerId);
    const voteCounts = {};
    session.voteCandidates.forEach(id => voteCounts[id] = 0);
    Object.values(session.votes).forEach(id => { voteCounts[id] += 1; });

    if (Object.keys(session.votes).length === 0) {
      io.to(roomId).emit('game_over', { isLiarCaught: false, liarId: session.liarId, word: session.selectedPair.word });
      return;
    }

    const maxVotes = Math.max(...Object.values(voteCounts));
    const tiedIds = Object.keys(voteCounts).filter(id => voteCounts[id] === maxVotes);

    if (tiedIds.length === 1) {
      const isLiarCaught = tiedIds[0] === session.liarId;
      
      if (isLiarCaught) {
        io.to(roomId).emit('liar_last_chance', { liarId: session.liarId, category: session.selectedPair.category });
      } else {
        io.to(roomId).emit('game_over', { isLiarCaught: false, liarId: session.liarId, mostVotedId: tiedIds[0], word: session.selectedPair.word });
      }
    } else {
      io.to(roomId).emit('tie_breaker_speech', { candidates: tiedIds, timeLimit: 30 });
      session.timerId = setTimeout(() => { startVotingPhase(roomId, session, tiedIds); }, 30 * 1000);
    }
  };

  socket.on('vote_end_discussion', () => {
    const roomId = getRoomId();
    const session = getSession();
    if (!session) return;

    session.discussionEndVotes++;
    io.to(roomId).emit('update_discussion_votes', { votes: session.discussionEndVotes });

    if (session.discussionEndVotes >= session.participantsCount) {
      endDiscussionPhase(roomId, session);
    }
  });

  socket.on('end_turn', () => {
    const roomId = getRoomId();
    const session = getSession();
    if (session) handleEndTurn(roomId, session);
  });

  socket.on('submit_liar_guess', (data) => {
    const roomId = getRoomId();
    const session = getSession();
    if (!session) return;

    const { guess } = data;
    const isCorrect = guess.trim() === session.selectedPair.word.trim();

    io.to(roomId).emit('game_over', {
      isLiarCaught: !isCorrect,
      liarId: session.liarId,
      word: session.selectedPair.word,
      liarGuess: guess,
      isLiarCorrect: isCorrect
    });
  });

  socket.on('disconnect', () => {
    const userInfo = socketUserMap[socket.id];
    if (userInfo) {
      const { userId, roomId } = userInfo;
      const session = activeGames[roomId];
      console.log(`🔴 유저 퇴장: 방(${roomId}) -> 유저(${userId})`);
      
      io.to(roomId).emit('player_left', { userId }); 
      delete socketUserMap[socket.id]; 

      if (session && session.participantsCount > 0) {
        session.participants = session.participants.filter(p => {
          const pId = p.participant?.id || p.user?.id || p.id;
          return pId !== userId;
        });
        session.participantsCount = session.participants.length;

        if (userId === session.liarId) {
          console.log(`🚨 방(${roomId}) 라이어 도주! 게임을 강제 종료합니다.`);
          clearTimeout(session.timerId);
          io.to(roomId).emit('game_over', {
            isLiarCaught: true, 
            liarId: session.liarId,
            word: session.selectedPair?.word,
            reason: 'LIAR_FLED'
          });
          return;
        }

        const currentSpeakerId = session.turnOrder[session.currentIndex];
        if (userId === currentSpeakerId && session.timerId) {
          handleEndTurn(roomId, session); 
        }

        session.turnOrder = session.turnOrder.filter(id => id !== userId);
        session.voteCandidates = session.voteCandidates.filter(id => id !== userId);
        
        // 방에 사람이 아무도 없으면 세션 데이터 정리 (메모리 누수 방지)
        if (session.participantsCount === 0) {
          clearTimeout(session.timerId);
          delete activeGames[roomId];
          console.log(`🗑️ 방(${roomId}) 인원이 0명이라 세션을 폭파했습니다.`);
        }
      }
    }
  });

  socket.on('return_to_lobby', () => {
    const roomId = getRoomId();
    const session = getSession();
    if (!session) return;

    clearTimeout(session.timerId);
    
    // 다음 판을 위해 세션 초기화
    session.readyCount = 0;
    session.turnOrder = [];
    session.currentIndex = 0;
    session.currentRound = 1;
    session.discussionEndVotes = 0;
    session.votes = {};
    session.liarId = null;
    session.selectedPair = null;
    session.voteCandidates = [];

    io.to(roomId).emit('game_reset');
  });
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`🚀 백엔드 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});