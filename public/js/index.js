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
  
  const signalingChannel = {};
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
      if (!window.location.hash) {
        return alert('請在網址列使用 #roomId=xxx 當作房間ID');
      }

      const roomIdResult = window.location.hash.match(/\#roomId=(\d+)/);
      if (!roomIdResult) {
        return alert('請傳入房間ID');
      }

      this.roomId = roomIdResult[1];

      // 建立 PeerConnection 相關事件與對應動作
      this.initPeerConnection();
    },
    methods: {
      invertIsUserNameSet() {
        this.isUserNameSet = !this.isUserNameSet;
        console.log('userName', this.userName);
        this.$nextTick(() => {
          // 設定 Firebase 收到相關事件與對應動作
          this.initFirebaseListener();

          // 取得用戶的視訊音頻串流
          this.tryToGetUserMedia();
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
        navigator
          .mediaDevices
            .getUserMedia(CONSTRAINTS)
            .then(success)
            .then((stream) => {
              this.peerConn.addStream(stream);
            })
            .catch(error);
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
          console.log('onicecandidate called', evt);
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
            console.log('我不是 caller, 自己會產 answer');
            return;
          }
          console.log('onnegotiationneeded called, 我是caller, 我要產 offer!');
          this.peerConn
                .createOffer()
                .then((offer) => {
                  console.log('執行 this.peerConn.setLocalDescription');
                  return this.peerConn.setLocalDescription(offer);
                })
                .then(() => {
                  // 透過 firebase 將 sdp 送出
                  console.log('透過 透過 firebase 將 sdp 送出, sdp:', this.peerConn.localDescription);
                  const sendData = {
                    userName: this.userName,
                    sdp: this.peerConn.localDescription
                  };
                  this.realtimeDB.push(JSON.stringify(sendData));
                })
                .catch((e) => console.error('[錯誤] onnegotiationneeded error:', e));
        }

        // 當取得串流時, 指定回 this.otherStream
        this.peerConn.onaddstream = (evt) => {
          console.log('onaddstream called');
          this.otherStream = evt.stream;

          // 同時清除 firebase 上的資訊
          this.realtimeDB.remove();
        };
      },

      /**
       * 設定 Firebase 收到相關事件與對應動作
       */
      initFirebaseListener() {
        console.log('initFirebaseListener');
        this.realtimeDB = firebase.database().ref(`rooms/${this.roomId}`);

        this.realtimeDB
          .once('value', (snapshot) => {
            const roomMap = snapshot.val();
            console.log('Firebase有資料過來囉!', roomMap);
            // TODO: 處理 sdp 交換事宜
            
            if (!roomMap) {
              console.log('沒有任何資料, 成為 caller!');
              this.setCaller(true);
              return;
            }
            this.setCaller(false);
          
            // 會執行到這, 就代表 isCaller = false, 只能產生 answer
            for (let key in roomMap) {
              const {
                userName,
                sdp,
                candidate,
              } = JSON.parse(roomMap[key]);
          
              if (this.userName === userName) {
                console.log('是自己的資料, 所以 pass');
                continue;
              }
          
              if (sdp) {
                console.log('收到 sdp:', roomMap[key]);
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
                      .then(() => {
                        // 透過 firebase 將 sdp 送出
                        console.log('透過 透過 firebase 將 sdp 送出, sdp:', this.peerConn.localDescription);
                        const sendData = {
                          userName: this.userName,
                          sdp: this.peerConn.localDescription
                        };
                        this.realtimeDB.push(JSON.stringify(sendData));
                      })
                      .catch((e) => console.error('[錯誤] createAnswer error:', e));
                    }
                  })
                  .catch((e) => console.error('setRemoteDescription error', e));
                return;
              }
          
              // 接收對方的 candidate 並加入自己的 RTCPeerConnection
              if (candidate) {
                console.log('收到 candicate:', roomMap[key]);
                this.peerConn.addIceCandidate(new RTCIceCandidate(candidate));
                return;
              }
            }
          });
      },

    }
  });

})();