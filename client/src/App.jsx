// client/src/App.jsx
import { useEffect, useState, useCallback } from 'react';
import { io } from 'socket.io-client';
import { DiscordSDK } from "@discord/embedded-app-sdk";
import { Play, Settings } from 'lucide-react';

import '@fontsource/caveat'; 
import '@fontsource/inter';
import '@fontsource/inter/800-italic.css';

import './App.css';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || window.location.origin;
const socket = io({
  path: '/server/socket.io', // 디스코드가 이걸 받아서 Railway의 /socket.io 로 전달합니다.
  transports: ['websocket']
});
const discordSdk = new DiscordSDK(import.meta.env.VITE_DISCORD_CLIENT_ID);

const SFX = {
  turn: new Audio('/sounds/turn.mp3'),
  tick: new Audio('/sounds/tick.mp3'),
  win: new Audio('/sounds/win.mp3'),
  lose: new Audio('/sounds/lose.mp3')
};

Object.values(SFX).forEach(audio => audio.volume = 0.4);

const playSound = (soundName) => {
  console.log(`🔊 [Sound] 재생 시도: ${soundName}`); // 콘솔에 찍히는지 확인용!
  
  const audio = SFX[soundName];
  if (audio) {
    audio.muted = false; // 혹시라도 음소거되어 있으면 강제로 풉니다.
    audio.volume = 0.5;  // 볼륨 50% 강제 고정
    audio.currentTime = 0; 
    
    audio.play().catch(error => {
      console.warn(`🔇 [Sound] ${soundName} 재생 실패:`, error);
    });
  }
};

const TRANSLATIONS = {
  English: {
    howToPlay: "How to play",
    rules: [
      { num: "01", title: "Secret Roles", desc: "A random Liar is selected. Everyone else receives a 'Key Word'. The Liar knows 'Category' only." },
      { num: "02", title: "Describe", desc: "Players give one-sentence descriptions of their word. Be vague enough to hide, clear enough to prove you're not the Liar." },
      { num: "03", title: "The Vote", desc: "Discuss and deliberate. Use your intuition to identify who doesn't belong and cast your vote." },
      { num: "04", title: "The Twist", desc: "If identified, the Liar has one last chance to guess the Key Word to steal the ultimate victory." }
    ],
    category: "Category",
    word: "Word",
    discussionTime: "Discussion Time",
    openDiscussion: "Open Discussion",
    descOneSentence: "Describe the word in one sentence",
    descFreeTalk: "Freely discuss to find the Liar!",
    endTurn: "END TURN"
  },
  Korean: {
    howToPlay: "게임 방법",
    rules: [
      { num: "01", title: "비밀 역할", desc: "무작위로 라이어가 선정됩니다. 다른 플레이어들은 '제시어'를 받으며, 라이어는 '주제'만 알 수 있습니다." },
      { num: "02", title: "단어 설명", desc: "돌아가며 제시어를 한 문장으로 설명합니다. 라이어에게 들키지 않으면서도, 자신이 시민임을 증명해야 합니다." },
      { num: "03", title: "투표 시간", desc: "모든 설명이 끝나면 토론을 통해 누가 라이어인지 추리하고 투표합니다." },
      { num: "04", title: "최후의 발악", desc: "라이어로 지목당하더라도, 마지막에 제시어를 정확히 맞히면 라이어가 역전승합니다." }
    ],
    category: "카테고리",
    word: "제시어",
    discussionTime: "토론 시간",
    openDiscussion: "전체 토론",
    descOneSentence: "한 문장으로 단어를 설명하세요.",
    descFreeTalk: "자유롭게 대화하며 라이어를 찾아내세요!",
    endTurn: "내 차례 끝내기"
  }
};

function App() {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [language, setLanguage] = useState('English');
  const [rounds, setRounds] = useState(2);
  const [timeLimit, setTimeLimit] = useState(15);
  const [discussionTime, setDiscussionTime] = useState(30);
  const [turnState, setTurnState] = useState({ speakerId: null, round: 1, totalRounds: 2, timeLeft: 0, isDiscussion: false });
  
  const [player, setPlayer] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [speakingUsers, setSpeakingUsers] = useState(new Set());

  const [gameState, setGameState] = useState('LOBBY');
  const [gameInfo, setGameInfo] = useState({ role: '', category: '', word: '' });

  const [turnOrder, setTurnOrder] = useState([]);
  const [currentTurnIndex, setCurrentTurnIndex] = useState(0);
  const [isReady, setIsReady] = useState(false);

  const [hasVotedEnd, setHasVotedEnd] = useState(false);
  const [discussionVotes, setDiscussionVotes] = useState(0);

  const [votedTarget, setVotedTarget] = useState(null);
  const [votedCount, setVotedCount] = useState(0);
  const [voteCandidates, setVoteCandidates] = useState([]);
  const [finalResult, setFinalResult] = useState(null); // { isLiarCaught, liarId, word ... }

  // 현재 선택된 언어의 텍스트 가져오기
  const t = TRANSLATIONS[language];

  const refreshParticipants = useCallback(async () => {
    try {
      const res = await discordSdk.commands.getInstanceConnectedParticipants();
      const participantsArray = res.participants ? res.participants : res;
      setParticipants(Array.isArray(participantsArray) ? participantsArray : []);
      console.log("참가자 목록 갱신 완료:", participantsArray);
    } catch (error) {
      console.error("참가자 목록을 불러오지 못했습니다.", error);
    }
  }, []);

  useEffect(() => {
    let isSubscribed = false;

    const handleJoin = (event) => {
      const newUser = event.participant || event.user || event;
      if (newUser && newUser.id) setParticipants((prev) => [...prev, newUser]);
    };
    
    const handleLeave = (event) => {
      const leftUserId = event?.participant?.id || event?.user?.id || event?.id;
      
      if (leftUserId) {
        setParticipants((prev) => {
          const updated = prev.filter(p => {
            const pId = p?.participant?.id || p?.user?.id || p?.id;
            return pId !== leftUserId;
          });
          console.log(`👋 ${leftUserId} 퇴장, 남은 인원: ${updated.length}`);
          return updated;
        });
      }
    };
    
    const handleSpeakingStart = (event) => {
      setSpeakingUsers((prev) => {
        const newSet = new Set(prev);
        const userId = event.user_id || (event.user && event.user.id) || event.id;
        newSet.add(userId);
        return newSet;
      });
    };
    
    const handleSpeakingStop = (event) => {
      setSpeakingUsers((prev) => {
        const newSet = new Set(prev);
        const userId = event.user_id || (event.user && event.user.id) || event.id;
        newSet.delete(userId);
        return newSet;
      });
    };

    const handleStartLoading = () => {
      console.log("📡 [Client] 로딩 시작 신호 받음");
      setGameState('ASSIGNING');
    };

    const handleRolesAssigned = (data) => {
      console.log("📡 [Client] 역할 배정 데이터 받음:", data);
      setPlayer(prevPlayer => {
        const isLiar = prevPlayer?.id === data.liarId;
        setGameInfo({
          role: isLiar ? 'LIAR' : 'CITIZEN',
          category: data.category,
          word: isLiar ? '???' : data.word
        });
        return prevPlayer;
      });
      
      setTurnOrder(data.turnOrder);
      setCurrentTurnIndex(0);
      setIsReady(false);
      setGameState('REVEAL');
    };

    const handleStartTurns = () => {
      setGameState('PLAYING'); // 게임(발언) 화면으로 전환!
    };

    const handleNextTurn = (data) => {
      setCurrentTurnIndex(data.currentIndex); // 다음 사람으로 인덱스 이동
    };

    const handleAllTurnsEnded = () => {
      // 임시로 로비로 돌아가게 해둡니다. (다음 단계에서 투표 화면으로 바꿀 예정)
      alert("모든 플레이어의 발언이 끝났습니다! (투표 단계 개발 대기중)");
      setGameState('LOBBY'); 
    };

    const setupDiscord = async () => {
      await discordSdk.ready();
      
      const { code } = await discordSdk.commands.authorize({
        client_id: import.meta.env.VITE_DISCORD_CLIENT_ID,
        response_type: "code",
        state: "",
        prompt: "none",
        scope: ["identify", "guilds", "rpc.voice.read"],
      });

      const response = await fetch('/server/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const { access_token } = await response.json();

      const auth = await discordSdk.commands.authenticate({ access_token });
      if (auth) {
        setPlayer(auth.user);
        socket.emit('register_player', { userId: auth.user.id, roomId: discordSdk.instanceId });
      }

      await refreshParticipants();
      socket.emit('join_signal');

      try {
        await discordSdk.subscribe('ACTIVITY_INSTANCE_PARTICIPANT_JOIN', handleJoin);
        await discordSdk.subscribe('ACTIVITY_INSTANCE_PARTICIPANT_LEAVE', handleLeave);
        
        await discordSdk.subscribe('SPEAKING_START', handleSpeakingStart, { channel_id: discordSdk.channelId });
        await discordSdk.subscribe('SPEAKING_STOP', handleSpeakingStop, { channel_id: discordSdk.channelId });
        isSubscribed = true;
      } catch (err) {
        console.error("이벤트 구독 실패:", err);
      }
    };

    setupDiscord();

    const handleTurnSync = (data) => {
      console.log("📡 [Client] 턴 동기화 데이터 수신:", data);
      
      setHasVotedEnd(false);
      setDiscussionVotes(0);
      
      if (data.turnOrder) {
        setTurnOrder(data.turnOrder);
      }
      
      setTurnState({
        speakerId: data.speakerId,
        round: data.round,
        totalRounds: data.totalRounds,
        timeLeft: data.timeLimit,
        isDiscussion: data.isDiscussion
      });
      
      setGameState('PLAYING'); 
    };

    const handleGameReset = () => {
      console.log("🧹 서버 명령 수신: 게임 상태를 초기화하고 로비로 돌아갑니다.");
      
      setGameInfo({ role: '', category: '', word: '' });
      setTurnOrder([]);
      setCurrentTurnIndex(0);
      setIsReady(false);
      setHasVotedEnd(false);
      setDiscussionVotes(0);
      setVotedTarget(null);
      setVotedCount(0);
      setVoteCandidates([]);
      setFinalResult(null);
      setTurnState({ speakerId: null, round: 1, totalRounds: 2, timeLeft: 0, isDiscussion: false });
      
      setGameState('LOBBY');
    };

    socket.on('turn_sync', handleTurnSync);
    socket.on('start_loading', handleStartLoading);
    socket.on('roles_assigned', handleRolesAssigned);
    socket.on('must_refresh_participants', refreshParticipants);
    socket.on('start_turns', handleStartTurns);
    socket.on('next_turn', handleNextTurn);
    socket.on('all_turns_ended', handleAllTurnsEnded);
    socket.on('update_discussion_votes', (data) => {
      setDiscussionVotes(data.votes);
    });
    socket.on('start_voting', (data) => {
      setVotedTarget(null);
      setVotedCount(0);
      setVoteCandidates(data.candidates);
      setTurnState(prev => ({ ...prev, timeLeft: data.timeLimit || 15 }));
      setGameState('VOTING');
    });

    socket.on('update_vote_count', (data) => {
      setVotedCount(data.votedCount);
    });

    socket.on('tie_breaker_speech', (data) => {
      setVoteCandidates(data.candidates); // 동점자 리스트
      setTurnState({
        speakerId: 'ALL',
        timeLeft: data.timeLimit,
        isDiscussion: true // 동점자끼리 자유 발언
      });
      setGameState('TIE_BREAKER');
    });

    socket.on('game_over', (data) => {
      setFinalResult(data);
      setGameState('RESULT');
    });

    socket.on('player_left', (data) => {
      console.log("👻 유령 퇴치 명령 수신:", data.userId);
      setParticipants((prev) => prev.filter((p) => {
        const pId = p?.participant?.id || p?.user?.id || p?.id;
        return pId !== data.userId;
      }));
    });

    socket.on('liar_last_chance', (data) => {
      setGameState('LIAR_GUESS');
    });
    socket.on('game_reset', handleGameReset);

    return () => {
      if (isSubscribed) {
        discordSdk.unsubscribe('ACTIVITY_INSTANCE_PARTICIPANT_JOIN', handleJoin);
        discordSdk.unsubscribe('ACTIVITY_INSTANCE_PARTICIPANT_LEAVE', handleLeave);
        discordSdk.unsubscribe('SPEAKING_START', handleSpeakingStart, { channel_id: discordSdk.channelId });
        discordSdk.unsubscribe('SPEAKING_STOP', handleSpeakingStop, { channel_id: discordSdk.channelId });
      }
      socket.off('start_loading', handleStartLoading);
      socket.off('roles_assigned', handleRolesAssigned);
      socket.off('must_refresh_participants', refreshParticipants);
      socket.off('start_turns', handleStartTurns);
      socket.off('next_turn', handleNextTurn);
      socket.off('all_turns_ended', handleAllTurnsEnded);
      socket.off('update_discussion_votes');
      socket.off('start_voting');
      socket.off('update_vote_count');
      socket.off('tie_breaker_speech');
      socket.off('game_over');
      socket.off('turn_sync', handleTurnSync);
      socket.off('player_left');
      socket.off('liar_last_chance');
      socket.off('game_reset', handleGameReset);
    };
  }, [refreshParticipants]);

  useEffect(() => {
    if (!['PLAYING', 'TIE_BREAKER', 'VOTING'].includes(gameState) || turnState.timeLeft <= 0) return;
    
    const timer = setInterval(() => {
      setTurnState(prev => ({ ...prev, timeLeft: prev.timeLeft - 1 }));
    }, 1000);

    return () => clearInterval(timer);
  }, [gameState, turnState.timeLeft]);

  // 🎵 1. 내 차례 알림음 ("띵~!")
  useEffect(() => {
    if (gameState === 'PLAYING' && turnState.speakerId === player?.id && !turnState.isDiscussion) {
      playSound('turn');
    }
  }, [gameState, turnState.speakerId, player?.id, turnState.isDiscussion]);

  // 🎵 2. 5초 카운트다운 타이머 ("째깍... 째깍...")
  useEffect(() => {
    // 발언 시간, 토론 시간, 투표 시간, 라이어 정답 시간 모두 적용
    const isTimerActive = ['PLAYING', 'VOTING', 'TIE_BREAKER', 'LIAR_GUESS'].includes(gameState);
    
    if (isTimerActive && turnState.timeLeft <= 5 && turnState.timeLeft > 0) {
      playSound('tick');
    }
  }, [gameState, turnState.timeLeft]);

  // 🎵 3. 최종 결과 승리/패배 효과음
  useEffect(() => {
    if (gameState === 'RESULT' && finalResult) {
      const isLiar = gameInfo.role === 'LIAR';
      const didLiarWin = finalResult.isLiarCorrect || !finalResult.isLiarCaught || finalResult.reason === 'LIAR_FLED';
      const didIWin = (isLiar && didLiarWin) || (!isLiar && !didLiarWin);

      if (didIWin) {
        playSound('win');
      } else {
        playSound('lose');
      }
    }
  }, [gameState, finalResult, gameInfo.role]);

  const handleStartGame = () => {
    setIsSettingsOpen(false);
    socket.emit('start_game', { 
      participants, 
      rounds, 
      timeLimit, 
      discussionTime, 
      language 
    });
  };

  const getAvatarUrl = (user) => {
    if (user && user.avatar) {
      return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`;
    }
    return `https://cdn.discordapp.com/embed/avatars/0.png`; 
  };

  return (
    <>
      {/* 🟢 gameState가 'LOBBY'일 때만 아래 랜딩 컨테이너를 보여줍니다 */}
      {gameState === 'LOBBY' && (
        <div className="landing-container">
          <div className="title-section">
            <div className="subtitle">Find the</div>
            <h1 className="main-title">LIAR</h1>
          </div>

          <div className="player-pill">
            {player ? (
              <img src={getAvatarUrl(player)} alt="my avatar" className="pill-avatar" />
            ) : (
              <div className="pill-avatar" />
            )}
            <span>player: {player ? player.username : 'Loading...'}</span>
          </div>

          <div className="action-buttons">
            {/* 👉 메인 화면의 START 버튼에 클릭 이벤트 연결! */}
            <button className="btn btn-primary" onClick={handleStartGame}>
              START <Play size={20} fill="currentColor" />
            </button>
            <button className="btn btn-secondary" onClick={() => setIsSettingsOpen(true)}>
              SETTINGS <Settings size={20} />
            </button>
          </div>

          <div className="connected-players">
            {Array.isArray(participants) && participants.map((user) => {
              const u = user.participant || user.user || user;
              if (!u || !u.id) return null;
              const isSpeaking = speakingUsers.has(u.id);
              
              return (
                <img 
                  key={u.id}
                  className={`avatar ${isSpeaking ? 'speaking' : ''}`}
                  src={getAvatarUrl(u)}
                  alt={u.username || 'user'}
                  title={u.username || 'user'}
                />
              );
            })}
          </div>

          <div className="how-to-play">
            <h2>{t.howToPlay}</h2>
            <div className="rules-grid">
              {t.rules.map((rule, index) => (
                <div className="rule-card" key={index}>
                  <div className="rule-number">{rule.num}</div>
                  <h3>{rule.title}</h3>
                  <p>{rule.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 🟢 gameState가 'LOBBY'이고, 세팅 모달이 열려있을 때 */}
      {gameState === 'LOBBY' && isSettingsOpen && (
        <div className="modal-overlay" onClick={() => setIsSettingsOpen(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <button className="close-btn" onClick={() => setIsSettingsOpen(false)}>✕</button>
            <h2 className="modal-title">Setting</h2>
            
            <div className="setting-row">
              <div className="setting-label">LANGUAGE:</div>
              <div className="setting-options">
                <button 
                  className={`option-btn ${language === 'English' ? 'active' : ''}`}
                  onClick={() => setLanguage('English')}
                >English</button>
                <button 
                  className={`option-btn ${language === 'Korean' ? 'active' : ''}`}
                  onClick={() => setLanguage('Korean')}
                >Korean</button>
              </div>
            </div>

            <div className="setting-row">
              <div className="setting-label">ROUND:</div>
              <div className="setting-options">
                {[2, 3, 4].map(num => (
                  <button 
                    key={num}
                    className={`option-btn ${rounds === num ? 'active' : ''}`}
                    onClick={() => setRounds(num)}
                  >{num}</button>
                ))}
              </div>
            </div>

            <div className="setting-row">
              <div className="setting-label">TIME:</div>
              <div className="setting-options">
                {[10, 15, 20, 30].map(time => (
                  <button 
                    key={time}
                    className={`option-btn ${timeLimit === time ? 'active' : ''}`}
                    onClick={() => setTimeLimit(time)}
                  >{time}s</button>
                ))}
              </div>
            </div>

            <div className="setting-row">
              <div className="setting-label">DISC. TIME:</div>
              <div className="setting-options">
                {[30, 60, 90, 120].map(time => (
                  <button 
                    key={time}
                    className={`option-btn ${discussionTime === time ? 'active' : ''}`}
                    onClick={() => setDiscussionTime(time)}
                  >{time}s</button>
                ))}
              </div>
            </div>

            <div style={{ marginTop: '2rem' }}>
              <button className="btn btn-primary" style={{ width: '100%' }} onClick={handleStartGame}>
                START <Play size={20} fill="currentColor" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 🟣 gameState가 'ASSIGNING'일 때 보여줄 새로운 전환 화면! */}
      {gameState === 'ASSIGNING' && (
        <div className="assigning-screen">
          <h1 className="assigning-title">Assigning Roles...</h1>
          <p className="assigning-subtitle">
            {language === 'Korean' ? '비밀 역할을 지정하는 중입니다' : 'Assigning secret roles to players'}
          </p>
        </div>
      )}

      {/* 🔵 gameState가 'REVEAL'일 때 보여줄 역할 확인 화면 */}
      {gameState === 'REVEAL' && (
        <div className="assigning-screen">
          <div className="role-card">
            <h2 className={`role-title ${gameInfo.role === 'LIAR' ? 'role-liar' : 'role-citizen'}`}>
              {gameInfo.role === 'LIAR' 
                ? (language === 'Korean' ? '당신은 라이어입니다' : 'YOU ARE THE LIAR') 
                : (language === 'Korean' ? '당신은 시민입니다' : 'CITIZEN')}
            </h2>
            
            <div className="word-box">
              <div className="word-category">
                {language === 'Korean' ? '주제' : 'CATEGORY'}: {gameInfo.category}
              </div>
              <div className="word-value">
                {gameInfo.word}
              </div>
            </div>
            
            <p className="assigning-subtitle" style={{ marginBottom: '2rem' }}>
              {gameInfo.role === 'LIAR' 
                ? (language === 'Korean' ? '정체를 숨기고 시민들의 설명을 듣고 단어를 유추하세요!' : 'Hide your identity and guess the word!')
                : (language === 'Korean' ? '라이어에게 단어를 들키지 않게 추상적으로 설명하세요!' : 'Describe the word without letting the Liar catch on!')}
            </p>

            <button 
              className="btn btn-primary" 
              style={{ width: '100%', opacity: isReady ? 0.6 : 1 }} 
              disabled={isReady}
              onClick={() => {
                setIsReady(true);
                socket.emit('player_ready'); // 서버에 "나 준비됐어!" 전송
              }}
            >
              {isReady 
                ? (language === 'Korean' ? '다른 플레이어 기다리는 중...' : 'Waiting for others...')
                : (language === 'Korean' ? '확인 완료 (게임 시작)' : 'Ready')}
            </button>
          </div>
        </div>
      )}

      {/* 🟠 gameState가 'PLAYING'일 때 보여줄 게임 화면! */}
      {gameState === 'PLAYING' && (
        <div className="playing-container">
          <div className="game-header">
            <div className="info-text">{t.category}: {gameInfo.category}</div>
            <div className="info-text" style={{ marginBottom: '1.5rem', fontWeight: 'bold' }}>
              {t.word}: {gameInfo.word}
            </div>
            
            <h1 className="discussion-title">
              {turnState.isDiscussion ? t.openDiscussion : t.discussionTime}
            </h1>
            <p className="discussion-subtitle">
              {turnState.isDiscussion ? t.descFreeTalk : t.descOneSentence}
            </p>
            
            <div className="timer-display">{turnState.timeLeft}</div>
          </div>

          <div className="avatar-grid">
            {/* 참가자를 서버에서 정해준 turnOrder 순서대로 렌더링합니다 */}
            {[...participants].sort((a, b) => {
              const idA = (a.participant || a.user || a).id;
              const idB = (b.participant || b.user || b).id;
              return turnOrder.indexOf(idA) - turnOrder.indexOf(idB);
            }).map((user) => {
              const u = user.participant || user.user || user;
              if (!u || !u.id) return null;
              
              const isSpeaking = speakingUsers.has(u.id);
              const isActiveTurn = turnState.isDiscussion || turnState.speakerId === u.id;
              const orderIndex = turnOrder.indexOf(u.id) + 1; // 1번부터 시작
              
              return (
                <div key={u.id} className={`avatar-wrapper ${isActiveTurn ? 'active' : 'dimmed'}`}>
                  <div className="avatar-relative-box">
                    <img 
                      className={`game-avatar ${isSpeaking ? 'speaking-border' : ''}`}
                      src={getAvatarUrl(u)}
                      alt={u.username}
                    />
                    {/* 순서 뱃지! */}
                    {orderIndex > 0 && <div className="turn-badge">{orderIndex}</div>}
                  </div>
                  <div className="avatar-name">{u.username}</div>
                </div>
              );
            })}
          </div>

          {turnState.isDiscussion ? (
            <button 
              className="btn end-turn-btn" 
              disabled={hasVotedEnd}
              onClick={() => {
                setHasVotedEnd(true);
                socket.emit('vote_end_discussion');
              }}
            >
              {hasVotedEnd 
                ? (language === 'Korean' ? `대기 중... (${discussionVotes}/${participants.length})` : `Waiting... (${discussionVotes}/${participants.length})`) 
                : (language === 'Korean' ? `토론 조기 종료 (${discussionVotes}/${participants.length})` : `END DISCUSSION (${discussionVotes}/${participants.length})`)}
            </button>
          ) : (
            turnState.speakerId === player?.id && (
              <button className="btn end-turn-btn" onClick={() => socket.emit('end_turn')}>
                {t.endTurn}
              </button>
            )
          )}

          <div className="round-badge">
            ROUND: {turnState.round} / {turnState.totalRounds}
          </div>
        </div>
      )}

      {/* ⚔️ gameState가 'TIE_BREAKER'일 때 (동점자 발생) */}
      {gameState === 'TIE_BREAKER' && (
        <div className="playing-container">
          <h1 className="discussion-title" style={{ color: '#ff4757' }}>최후의 변론</h1>
          <p className="discussion-subtitle">동점표가 발생했습니다! 용의자들의 마지막 해명을 들어보세요.</p>
          <div className="timer-display" style={{ color: '#ff4757' }}>{turnState.timeLeft}</div>
          
          <div className="avatar-grid">
             {/* 위와 똑같은 정렬 로직 사용 (voteCandidates.includes(u.id) 인 사람만 강조) */}
             {participants.map((user) => {
                const u = user.participant || user.user || user;
                const isSuspect = voteCandidates.includes(u.id);
                return (
                  <div key={u.id} className={`avatar-wrapper ${isSuspect ? 'active' : 'dimmed'}`} style={{ opacity: isSuspect ? 1 : 0.2 }}>
                    <img className={`game-avatar ${speakingUsers.has(u.id) ? 'speaking-border' : ''}`} src={getAvatarUrl(u)} alt={u.username} />
                    <div className="avatar-name">{u.username}</div>
                  </div>
                );
             })}
          </div>
        </div>
      )}

      {/* 🗳️ gameState가 'VOTING'일 때 */}
      {gameState === 'VOTING' && (
        <div className="playing-container">
          <h1 className="discussion-title">{voteCandidates.length < participants.length ? '재투표 진행' : '라이어 지목'}</h1>
          <p className="discussion-subtitle">의심되는 사람을 선택하세요.</p>
          <div className="timer-display">{turnState.timeLeft}</div>

          <div className="avatar-grid">
            {participants.map((user) => {
              const u = user.participant || user.user || user;
              const isMe = u.id === player?.id;
              const isCandidate = voteCandidates.includes(u.id); // 투표 후보인지 확인
              
              return (
                <div 
                  key={u.id} 
                  // 후보가 아니면 아예 클릭 못하게 dimmed 처리
                  className={`avatar-wrapper ${!isCandidate ? 'dimmed' : 'active'} ${votedTarget === u.id ? 'voted-highlight' : ''}`}
                  onClick={() => {
                    if (isCandidate && !votedTarget && !isMe) {
                      setVotedTarget(u.id);
                      socket.emit('submit_vote', { voterId: player.id, targetId: u.id });
                    }
                  }}
                  style={{ 
                    cursor: (isCandidate && !votedTarget && !isMe) ? 'pointer' : 'default', 
                    opacity: isCandidate ? (isMe ? 0.5 : 1) : 0.1 
                  }}
                >
                  <img className="game-avatar" src={getAvatarUrl(u)} alt={u.username} />
                  <div className="avatar-name">{u.username} {isMe && '(ME)'}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 🎭 gameState가 'LIAR_GUESS'일 때 */}
      {gameState === 'LIAR_GUESS' && (
        <div className="assigning-screen">
          <div className="role-card" style={{ borderColor: '#ff4757' }}>
            <h2 className="role-title role-liar">
              {gameInfo.role === 'LIAR' 
                ? (language === 'Korean' ? '마지막 기회!' : 'LAST CHANCE!') 
                : (language === 'Korean' ? '라이어의 반격' : 'LIAR IS GUESSING')}
            </h2>
            <p className="assigning-subtitle">
              {gameInfo.role === 'LIAR' 
                ? (language === 'Korean' ? '제시어를 맞춰보세요. 맞히면 역전승입니다!' : 'Guess the word to steal the victory!')
                : (language === 'Korean' ? '라이어가 정답을 생각 중입니다...' : 'The Liar is thinking of the word...')}
            </p>

            <div className="word-box">
              <div className="word-category">{language === 'Korean' ? '주제' : 'CATEGORY'}: {gameInfo.category}</div>
              {gameInfo.role === 'LIAR' && (
                <input 
                  type="text" 
                  className="liar-input"
                  placeholder={language === 'Korean' ? '단어를 입력하세요' : 'Enter the word'}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      socket.emit('submit_liar_guess', { guess: e.target.value });
                    }
                  }}
                  autoFocus
                />
              )}
            </div>
          
            {gameInfo.role === 'LIAR' && (
              <p style={{ fontSize: '0.8rem', color: '#666' }}>Press Enter to Submit</p>
            )}
          </div>
        </div>
      )}

      {/* 🏆 gameState가 'RESULT'일 때 */}
      {gameState === 'RESULT' && (
        <div className="assigning-screen">
          <div className="role-card">
            <h1 className="word-category" style={{ fontSize: '1.5rem' }}>GAME OVER</h1>
            <h2 className={`role-title ${finalResult.isLiarCaught ? 'role-citizen' : 'role-liar'}`}>
              {finalResult.isLiarCaught 
                ? (language === 'Korean' ? '시민 승리!' : 'CITIZENS WIN!') 
                : (language === 'Korean' ? '라이어 승리!' : 'LIAR WINS!')}
            </h2>
            
            <div className="word-box">
              <div className="word-category">{language === 'Korean' ? '제시어' : 'WORD'}</div>
              <div className="word-value">{finalResult.word}</div>
            </div>

            <p className="assigning-subtitle">
              {finalResult.reason === 'LIAR_FLED'
                ? (language === 'Korean' ? '라이어가 탈주했습니다 시민 승리!' : 'The Liar fled! Citizens Win!')
                : finalResult.isLiarCorrect 
                  ? (language === 'Korean' ? `라이어가 정답 [${finalResult.word}]을(를) 맞혔습니다! 라이어의 역전승!` : `Liar guessed [${finalResult.word}] correctly! Liar steals the win!`)
                  : finalResult.isLiarCaught 
                    ? (language === 'Korean' ? '라이어를 완벽하게 검거했습니다!' : 'Successfully caught the Liar!')
                    : (language === 'Korean' ? '시민이 잘못 지목되어 라이어가 승리했습니다.' : 'Liar wins due to wrong accusation.')}
            </p>

            <button 
              className="btn btn-primary" 
              style={{ width: '100%', marginTop: '2rem' }} 
              onClick={() => socket.emit('return_to_lobby')}
            >
              {language === 'Korean' ? '로비로 돌아가기' : 'BACK TO LOBBY'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export default App;