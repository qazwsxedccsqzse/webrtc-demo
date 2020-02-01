(() => {

  const REALTIME_DB_CONFIG = {
    databaseURL: "https://instantmsg-847fc.firebaseio.com",
  };
  firebase.initializeApp(REALTIME_DB_CONFIG);

  const ICE_SERVERS = [{
    'urls': [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun2.l.google.com:19302',
      'stun:stun.l.google.com:19302?transport=udp',
    ]
  }];

  const CONSTRAINTS = {
    audio: false,
		video: true
  };

  const PEER_CONNECTION_CONFIG = {
    iceServers: ICE_SERVERS,
  };

  const vm = new Vue({
    el: '#app',
    data: {
      isUserNameSet: false,
      userName: '',
      roomId: 0,
      selfStream: null,  // 自己的視訊or音頻串流
      otherStream: null, // 別人的視訊or音頻串流
      peerConn: null,
      realtimeDB: null,
      isCaller: false,
      isSetCaller: false,
    },
    mounted() {
      const randRoomId = Math.ceil(1000 * Math.random());
      if (!window.location.hash) {
        window.location.hash = `#roomId=${randRoomId}`;
      }

      let roomIdResult = window.location.hash.match(/\#roomId=(\d+)/);
      if (!roomIdResult) {
        window.location.hash = `#roomId=${randRoomId}`;
        roomIdResult = [, randRoomId];
      }

      this.roomId = roomIdResult[1];

      // 初始化 realtime database
      this.initRealtimeDB();
      // 建立 PeerConnection 相關事件與對應動作
      this.initPeerConnection();
    },
    methods: {
      invertIsUserNameSet() {
        this.isUserNameSet = !this.isUserNameSet;
        console.log('userName', this.userName);
        this.$nextTick(() => {
          this.judgeAndSetCaller()
          .then((isCaller) => {
            if (isCaller === true) {
              console.log('[我是Caller] 先處理 initFirebaseListener 再設定本地端的串流');
              // 設定 Firebase 收到相關事件與對應動作
              this.initFirebaseListener();
              this.tryToGetUserMedia()
              .then((gumStream) => {
                // console.log('gumStream', gumStream);
                for (const track of gumStream.getTracks()) {
                  this.peerConn.addTrack(track);
                }
              })
            } else {
              console.log('[我不是Caller] 先設定本地端的串流再處理 initFirebaseListener');
              // 取得用戶的視訊音頻串流
              this.tryToGetUserMedia()
              .then((gumStream) => {
                return new Promise((resolve) => {
                  for (const track of gumStream.getTracks()) {
                    this.peerConn.addTrack(track);
                  }
                  resolve(1);
                })
              })
              .then(() => {
                // 設定 Firebase 收到相關事件與對應動作
                this.initFirebaseListener();
              });
            }
          });
          
        })
      },

      setCaller(isCaller) {
        if (this.isSetCaller === true) {
          return;
        }
        this.isCaller = isCaller;
        this.isSetCaller = true;
      },

      /**
       * 嘗試取得用戶的攝影機串流
       */
      tryToGetUserMedia() {
        // 建立成功與失敗的 callback
        const success = (stream) => {
          this.selfStream = stream;
          return new Promise((resolve, reject) => {
            resolve(stream);
          });
        };

        const error = function(error) {
          console.error('getUserMediaError:', error);
        };

        // 在 https 上只會取得一次權限
        return navigator
          .mediaDevices
            .getUserMedia(CONSTRAINTS)
            .then(success)
            .catch(error);
      },

      sendSdpToFirebase() {
        // 透過 firebase 將 sdp 送出
        console.log('透過 透過 firebase 將 sdp 送出, sdp:', this.peerConn.localDescription);
        const sendData = {
          userName: this.userName,
          sdp: this.peerConn.localDescription
        };
        this.realtimeDB.push(JSON.stringify(sendData));
      },

      /**
       * 建立 PeerConnection 相關事件與對應動作
       */
      initPeerConnection() {
        console.log('initPeerConnection');
        // 建立 peer connection
        this.peerConn = new RTCPeerConnection(PEER_CONNECTION_CONFIG);

        // 當有任何 ICE candidates 可用時，
        // 透過 Firebase 將 candidate 傳送給對方
        this.peerConn.onicecandidate = (evt) => {
          // console.log('onicecandidate called', evt);
          if (evt.candidate) {
            const sendData = {
              userName: this.userName,
              candidate: evt.candidate,
            };
            this.realtimeDB.push(JSON.stringify(sendData));
          }
        };

        this.peerConn.onnegotiationneeded = () => {
          if (this.isCaller !== true) {
            console.log('我不是 caller, 自己會產 answer, 現階段跳過');
            return;
          }
          console.log('onnegotiationneeded called, 我是caller, 我要產 offer!');
          this.peerConn
                .createOffer()
                .then((offer) => {
                  console.log('執行 this.peerConn.setLocalDescription');
                  return this.peerConn.setLocalDescription(offer);
                })
                .then(this.sendSdpToFirebase)
                .catch((e) => console.error('[錯誤] onnegotiationneeded error:', e));
        }

        // 當取得串流時, 指定回 this.otherStream
        this.peerConn.ontrack = (evt) => {
          console.log('ontrack called', evt);
          if (evt.streams && evt.streams[0]) {
            this.otherStream = evt.streams[0];
          } else {
            console.log('收到遠端串流');
            const inboundStream = new MediaStream();
            this.otherStream = inboundStream;
            inboundStream.addTrack(evt.track);
            inboundStream.onremovetrack = (evt) => {
              console.log("Removed: " + evt.track.kind + ": " + evt.track.label);
            };
          }

          // 同時清除 firebase 上的資訊
          this.realtimeDB.remove();
        };

        const intervalId = setInterval(() => {
          console.log(`現在連接狀態為 ${this.peerConn.connectionState}`);
          if (this.peerConn.connectionState === 'disconnected') {
            clearInterval(intervalId);
            Swal.fire({
              title: '錯誤',
              text: '對方已斷線',
              icon: 'warning',
            });
          }
          if (this.peerConn.connectionState === 'failed') {
            clearInterval(intervalId);
            Swal.fire({
              title: '失敗',
              text: '連接失敗 (有一方連接不上ice)',
              icon: 'warning',
            });
          }
        }, 3000);
      },

      /**
       * 初始化 realtime database
       */
      initRealtimeDB() {
        this.realtimeDB = firebase.database().ref(`rooms/${this.roomId}`);
      },

      /**
       * 判斷並且設定用戶是不是為 caller
       */
      judgeAndSetCaller() {
        // 設定誰是 caller
        return new Promise((resolve) => {
          this.realtimeDB.once('value', (snapshot) => {
            const roomMap = snapshot.val();
            if (!roomMap) {
              console.log('我是caller');
              this.setCaller(true);
              resolve(true);
              return;
            }
            console.log('我不是caller');
            this.setCaller(false);
            resolve(false);
          });
        })
      },

      /**
       * 設定 Firebase 收到相關事件與對應動作
       */
      initFirebaseListener() {
        console.log('initFirebaseListener');
        this.realtimeDB
            .on('child_added', (snapshot) => {
              const roomMap = snapshot.val();
              if (!roomMap) {
                return;
              }
              // TODO: 處理 sdp 交換事宜
              // console.log('Firebase 資料', roomMap);
            
              // 會執行到這, 就代表 isCaller = false, 只能產生 answer
              const {
                userName,
                sdp,
                candidate,
              } = JSON.parse(roomMap);
          
              if (this.userName === userName) {
                // console.log('是自己的資料, 所以 pass');
                return;
              }

              if (sdp) {
                console.log('收到 sdp');
                // 將收到不是自己的 sdp 設定為自己的 remote
                this.peerConn.setRemoteDescription(new RTCSessionDescription(sdp))
                  .then(() => {
                    console.log('此時 this.peerConn.remoteDescription.type = ', this.peerConn.remoteDescription.type);
                    if ('offer' === this.peerConn.remoteDescription.type) {
                      this.peerConn.createAnswer()
                      .then((answer) => {
                        console.log('[answer] 執行 this.peerConn.setLocalDescription');
                        return this.peerConn.setLocalDescription(answer);
                      })
                      .then(this.sendSdpToFirebase)
                      .catch((e) => console.error('[錯誤] createAnswer error:', e));
                    }
                  })
                  .catch((e) => console.error('setRemoteDescription error', e));
                return;
              }

              // 接收對方的 candidate 並加入自己的 RTCPeerConnection
              if (candidate) {
                // console.log('收到 candicate:', roomMap);
                this.peerConn.addIceCandidate(new RTCIceCandidate(candidate));
                return;
              }
            });
      },

      clearFirebase() {
        if (!this.realtimeDB) {
          return;
        }
        this.realtimeDB.remove();
        Swal.fire({
          title: '成功',
          text: '已成功清除',
          icon: 'success',
        });
      },

      screenshot() {
        const canvas = this.$refs['canvas'];
        canvas.width = window.innerWidth;
        canvas.height = this.$refs['otherVideo'].clientHeight;
        canvas.getContext('2d').drawImage(
          this.$refs['otherVideo'],
          0,
          0,
          canvas.width,
          canvas.height
        );
      }
    }
  });

})();