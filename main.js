import { ZstdCodec } from 'zstd-codec';

// ===== Constants =====
const CHUNK_SIZE = 64 * 1024; // 64KB chunks
const BUFFER_THRESHOLD = 1024 * 1024; // 1MB - wait if bufferedAmount exceeds this
const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
];

// ===== Global State =====
let peerConnection = null;
let dataChannel = null;
let zstdCodec = null;
let isCompressing = true;
let compressionLevel = 3;

// File transfer state
let incomingFile = null;
let receivedChunks = [];
let receivedSize = 0;

// Benchmark state
let benchmark = {
    startTime: 0,
    endTime: 0,
    compressionTime: 0,
    decompressionTime: 0,
    originalSize: 0,
    compressedSize: 0,
    chunksSent: 0,
    chunksReceived: 0
};

// ===== DOM Elements =====
const elements = {
    // Connection
    createOfferBtn: document.getElementById('createOfferBtn'),
    createAnswerBtn: document.getElementById('createAnswerBtn'),
    localSdp: document.getElementById('localSdp'),
    remoteSdp: document.getElementById('remoteSdp'),
    copyLocalSdp: document.getElementById('copyLocalSdp'),
    setRemoteSdp: document.getElementById('setRemoteSdp'),
    statusIndicator: document.getElementById('statusIndicator'),
    connectionStatus: document.getElementById('connectionStatus'),

    // Transfer
    compressionToggle: document.getElementById('compressionToggle'),
    compressionLevel: document.getElementById('compressionLevel'),
    fileInput: document.getElementById('fileInput'),
    fileText: document.getElementById('fileText'),
    sendFileBtn: document.getElementById('sendFileBtn'),
    progressContainer: document.getElementById('progressContainer'),
    progressFill: document.getElementById('progressFill'),
    progressPercent: document.getElementById('progressPercent'),
    progressSize: document.getElementById('progressSize'),
    receivedFiles: document.getElementById('receivedFiles'),
    fileList: document.getElementById('fileList'),

    // Benchmark
    statTransferTime: document.getElementById('statTransferTime'),
    statCompressionTime: document.getElementById('statCompressionTime'),
    statCompressionRatio: document.getElementById('statCompressionRatio'),
    statThroughput: document.getElementById('statThroughput'),
    logOutput: document.getElementById('logOutput'),
    clearLogs: document.getElementById('clearLogs')
};

// ===== Logging =====
function log(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3
    });

    const logLine = document.createElement('div');
    logLine.className = `log-${type}`;
    logLine.textContent = `[${timestamp}] ${message}`;
    elements.logOutput.appendChild(logLine);
    elements.logOutput.scrollTop = elements.logOutput.scrollHeight;

    console.log(`[${type.toUpperCase()}] ${message}`);
}

function logSeparator() {
    const sep = document.createElement('div');
    sep.className = 'log-highlight';
    sep.textContent = '─'.repeat(50);
    elements.logOutput.appendChild(sep);
}

// ===== Zstd Initialization =====
async function initZstd() {
    return new Promise((resolve, reject) => {
        ZstdCodec.run((zstd) => {
            zstdCodec = new zstd.Streaming();
            log('Zstd WASM codec initialized', 'success');
            resolve();
        });
    });
}

// ===== Compression Functions =====
function compressData(data, level = 3) {
    if (!zstdCodec) {
        throw new Error('Zstd codec not initialized');
    }
    const startTime = performance.now();
    const compressed = zstdCodec.compress(new Uint8Array(data), level);
    const endTime = performance.now();
    return {
        data: compressed,
        time: endTime - startTime
    };
}

function decompressData(data) {
    if (!zstdCodec) {
        throw new Error('Zstd codec not initialized');
    }
    const startTime = performance.now();
    const decompressed = zstdCodec.decompress(new Uint8Array(data));
    const endTime = performance.now();
    return {
        data: decompressed,
        time: endTime - startTime
    };
}

// ===== WebRTC Functions =====
function createPeerConnection() {
    peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            log(`ICE candidate gathered: ${event.candidate.candidate.slice(0, 50)}...`);
        } else {
            // All ICE candidates gathered - update the local SDP display
            elements.localSdp.value = JSON.stringify(peerConnection.localDescription);
            log('All ICE candidates gathered', 'success');
        }
    };

    peerConnection.onconnectionstatechange = () => {
        updateConnectionStatus(peerConnection.connectionState);
    };

    peerConnection.ondatachannel = (event) => {
        log('Data channel received from remote peer', 'success');
        setupDataChannel(event.channel);
    };

    log('RTCPeerConnection created');
}

function setupDataChannel(channel) {
    dataChannel = channel;
    dataChannel.binaryType = 'arraybuffer';

    dataChannel.onopen = () => {
        log('Data channel opened', 'success');
        updateConnectionStatus('connected');
        elements.sendFileBtn.disabled = !elements.fileInput.files.length;
    };

    dataChannel.onclose = () => {
        log('Data channel closed', 'warning');
        updateConnectionStatus('disconnected');
        elements.sendFileBtn.disabled = true;
    };

    dataChannel.onerror = (error) => {
        log(`Data channel error: ${error.message}`, 'error');
    };

    dataChannel.onmessage = handleDataChannelMessage;
}

function updateConnectionStatus(state) {
    elements.connectionStatus.textContent = state.charAt(0).toUpperCase() + state.slice(1);
    elements.statusIndicator.className = 'status-indicator';

    switch (state) {
        case 'connecting':
        case 'new':
            elements.statusIndicator.classList.add('connecting');
            break;
        case 'connected':
            elements.statusIndicator.classList.add('connected');
            break;
        case 'disconnected':
        case 'failed':
        case 'closed':
            elements.statusIndicator.classList.add('error');
            break;
    }
}

async function createOffer() {
    createPeerConnection();

    // Create data channel (only the offerer creates it)
    const channel = peerConnection.createDataChannel('fileTransfer', {
        ordered: true
    });
    setupDataChannel(channel);

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    log('Offer created - waiting for ICE candidates...');
    updateConnectionStatus('connecting');
}

async function createAnswer() {
    const remoteSdpText = elements.remoteSdp.value.trim();
    if (!remoteSdpText) {
        log('Please paste the remote SDP first', 'error');
        return;
    }

    try {
        createPeerConnection();

        const remoteDesc = JSON.parse(remoteSdpText);
        await peerConnection.setRemoteDescription(remoteDesc);
        log('Remote offer set');

        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        log('Answer created - waiting for ICE candidates...');
        updateConnectionStatus('connecting');
    } catch (error) {
        log(`Error creating answer: ${error.message}`, 'error');
    }
}

async function setRemoteDescription() {
    const remoteSdpText = elements.remoteSdp.value.trim();
    if (!remoteSdpText) {
        log('Please paste the remote SDP first', 'error');
        return;
    }

    try {
        const remoteDesc = JSON.parse(remoteSdpText);
        await peerConnection.setRemoteDescription(remoteDesc);
        log('Remote description set', 'success');
    } catch (error) {
        log(`Error setting remote description: ${error.message}`, 'error');
    }
}

// ===== File Transfer Functions =====
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Wait for DataChannel buffer to drain below threshold
function waitForBufferDrain(channel, threshold) {
    return new Promise((resolve) => {
        if (channel.bufferedAmount <= threshold) {
            resolve();
            return;
        }

        // Use bufferedAmountLowThreshold for efficient waiting
        channel.bufferedAmountLowThreshold = threshold;

        const onBufferLow = () => {
            channel.removeEventListener('bufferedamountlow', onBufferLow);
            resolve();
        };

        channel.addEventListener('bufferedamountlow', onBufferLow);
    });
}

async function sendFile() {
    const file = elements.fileInput.files[0];
    if (!file) {
        log('No file selected', 'error');
        return;
    }

    if (!dataChannel || dataChannel.readyState !== 'open') {
        log('Data channel not ready', 'error');
        return;
    }

    // Reset benchmark
    benchmark = {
        startTime: performance.now(),
        endTime: 0,
        compressionTime: 0,
        decompressionTime: 0,
        originalSize: file.size,
        compressedSize: 0,
        chunksSent: 0,
        chunksReceived: 0
    };

    const useCompression = elements.compressionToggle.checked;
    const level = parseInt(elements.compressionLevel.value);

    logSeparator();
    log(`Starting transfer: ${file.name} (${formatBytes(file.size)})`, 'highlight');
    log(`Compression: ${useCompression ? `ENABLED (zstd level ${level})` : 'DISABLED'}`);

    // Send file metadata
    const metadata = {
        type: 'metadata',
        name: file.name,
        size: file.size,
        mimeType: file.type,
        compressed: useCompression,
        compressionLevel: level,
        totalChunks: Math.ceil(file.size / CHUNK_SIZE)
    };
    dataChannel.send(JSON.stringify(metadata));

    // Show progress
    elements.progressContainer.style.display = 'block';

    // Read and send file in chunks
    const arrayBuffer = await file.arrayBuffer();
    const totalChunks = Math.ceil(arrayBuffer.byteLength / CHUNK_SIZE);

    for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, arrayBuffer.byteLength);
        let chunk = arrayBuffer.slice(start, end);

        let chunkToSend = chunk;
        let compressionRatioText = '';

        if (useCompression) {
            const result = compressData(chunk, level);
            chunkToSend = result.data;
            benchmark.compressionTime += result.time;
            benchmark.compressedSize += result.data.length;

            const ratio = chunk.byteLength / result.data.length;
            compressionRatioText = ` → ${formatBytes(result.data.length)} (${ratio.toFixed(1)}x) [compress: ${result.time.toFixed(1)}ms]`;
        } else {
            benchmark.compressedSize += chunk.byteLength;
        }

        // Send chunk header
        const chunkHeader = {
            type: 'chunk',
            index: i,
            originalSize: chunk.byteLength,
            compressedSize: chunkToSend.byteLength || chunkToSend.length
        };
        dataChannel.send(JSON.stringify(chunkHeader));

        // Send chunk data
        dataChannel.send(chunkToSend);
        benchmark.chunksSent++;

        log(`Chunk ${i + 1}/${totalChunks}: ${formatBytes(chunk.byteLength)}${compressionRatioText}`);

        // Update progress
        const progress = ((i + 1) / totalChunks) * 100;
        elements.progressFill.style.width = `${progress}%`;
        elements.progressPercent.textContent = `${Math.round(progress)}%`;
        elements.progressSize.textContent = `${formatBytes(end)} / ${formatBytes(file.size)}`;

        // Wait for buffer to drain if it's too full (backpressure handling)
        if (dataChannel.bufferedAmount > BUFFER_THRESHOLD) {
            log(`Buffer full (${formatBytes(dataChannel.bufferedAmount)}), waiting to drain...`, 'warning');
            await waitForBufferDrain(dataChannel, BUFFER_THRESHOLD);
        }
    }

    // Send completion message
    dataChannel.send(JSON.stringify({ type: 'complete' }));

    benchmark.endTime = performance.now();
    logTransferStats('SENT');
}

function handleDataChannelMessage(event) {
    if (typeof event.data === 'string') {
        const message = JSON.parse(event.data);

        switch (message.type) {
            case 'metadata':
                handleFileMetadata(message);
                break;
            case 'chunk':
                incomingFile.currentChunk = message;
                break;
            case 'complete':
                handleTransferComplete();
                break;
        }
    } else {
        // Binary data - this is a chunk
        handleChunkData(event.data);
    }
}

function handleFileMetadata(metadata) {
    logSeparator();
    log(`Receiving: ${metadata.name} (${formatBytes(metadata.size)})`, 'highlight');
    log(`Compression: ${metadata.compressed ? `ENABLED (zstd level ${metadata.compressionLevel})` : 'DISABLED'}`);

    incomingFile = {
        name: metadata.name,
        size: metadata.size,
        mimeType: metadata.mimeType,
        compressed: metadata.compressed,
        totalChunks: metadata.totalChunks,
        currentChunk: null
    };

    receivedChunks = [];
    receivedSize = 0;

    // Reset benchmark for receiving
    benchmark = {
        startTime: performance.now(),
        endTime: 0,
        compressionTime: 0,
        decompressionTime: 0,
        originalSize: metadata.size,
        compressedSize: 0,
        chunksSent: 0,
        chunksReceived: 0
    };

    elements.progressContainer.style.display = 'block';
}

function handleChunkData(data) {
    if (!incomingFile || !incomingFile.currentChunk) return;

    const chunkInfo = incomingFile.currentChunk;
    let chunkData = data;
    let decompressionText = '';

    benchmark.compressedSize += data.byteLength;

    if (incomingFile.compressed) {
        const result = decompressData(data);
        chunkData = result.data;
        benchmark.decompressionTime += result.time;
        decompressionText = ` [decompress: ${result.time.toFixed(1)}ms]`;
    }

    receivedChunks.push(chunkData);
    receivedSize += chunkData.byteLength || chunkData.length;
    benchmark.chunksReceived++;

    log(`Chunk ${chunkInfo.index + 1}/${incomingFile.totalChunks}: received${decompressionText}`);

    // Update progress
    const progress = (benchmark.chunksReceived / incomingFile.totalChunks) * 100;
    elements.progressFill.style.width = `${progress}%`;
    elements.progressPercent.textContent = `${Math.round(progress)}%`;
    elements.progressSize.textContent = `${formatBytes(receivedSize)} / ${formatBytes(incomingFile.size)}`;

    incomingFile.currentChunk = null;
}

function handleTransferComplete() {
    benchmark.endTime = performance.now();

    // Combine all chunks
    const totalLength = receivedChunks.reduce((sum, chunk) => sum + (chunk.byteLength || chunk.length), 0);
    const combinedData = new Uint8Array(totalLength);
    let offset = 0;

    for (const chunk of receivedChunks) {
        combinedData.set(new Uint8Array(chunk.buffer || chunk), offset);
        offset += chunk.byteLength || chunk.length;
    }

    // Create download link
    const blob = new Blob([combinedData], { type: incomingFile.mimeType || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);

    // Add to received files list
    elements.receivedFiles.style.display = 'block';
    const fileEntry = document.createElement('div');
    fileEntry.className = 'received-file';
    fileEntry.innerHTML = `
    <div class="received-file-info">
      <span class="received-file-name">📄 ${incomingFile.name}</span>
      <span class="received-file-size">(${formatBytes(incomingFile.size)})</span>
    </div>
    <a href="${url}" download="${incomingFile.name}" class="btn btn-small btn-primary">⬇ Download</a>
  `;
    elements.fileList.appendChild(fileEntry);

    logTransferStats('RECEIVED');

    // Reset state
    incomingFile = null;
    receivedChunks = [];
    receivedSize = 0;
}

function logTransferStats(direction) {
    const totalTime = benchmark.endTime - benchmark.startTime;
    const networkTime = totalTime - benchmark.compressionTime - benchmark.decompressionTime;
    const ratio = benchmark.originalSize / benchmark.compressedSize;
    const throughput = (benchmark.originalSize / totalTime) * 1000; // bytes per second

    logSeparator();
    log(`Transfer complete! (${direction})`, 'success');
    logSeparator();
    log(`Total time: ${totalTime.toFixed(0)}ms`, 'highlight');

    if (benchmark.compressionTime > 0) {
        log(`Compression time: ${benchmark.compressionTime.toFixed(0)}ms`);
    }
    if (benchmark.decompressionTime > 0) {
        log(`Decompression time: ${benchmark.decompressionTime.toFixed(0)}ms`);
    }
    log(`Network time: ${networkTime.toFixed(0)}ms`);
    log(`Original: ${formatBytes(benchmark.originalSize)}`);
    log(`Transferred: ${formatBytes(benchmark.compressedSize)}`);
    log(`Ratio: ${ratio.toFixed(2)}x`);
    log(`Throughput: ${formatBytes(throughput)}/s`);

    // Update stats cards
    elements.statTransferTime.textContent = `${totalTime.toFixed(0)}ms`;
    elements.statCompressionTime.textContent = `${(benchmark.compressionTime + benchmark.decompressionTime).toFixed(0)}ms`;
    elements.statCompressionRatio.textContent = `${ratio.toFixed(2)}x`;
    elements.statThroughput.textContent = `${formatBytes(throughput)}/s`;
}

// ===== Event Listeners =====
elements.createOfferBtn.addEventListener('click', createOffer);
elements.createAnswerBtn.addEventListener('click', createAnswer);

elements.copyLocalSdp.addEventListener('click', () => {
    navigator.clipboard.writeText(elements.localSdp.value);
    log('Local SDP copied to clipboard', 'success');
});

elements.setRemoteSdp.addEventListener('click', setRemoteDescription);

elements.compressionToggle.addEventListener('change', (e) => {
    isCompressing = e.target.checked;
    log(`Compression ${isCompressing ? 'enabled' : 'disabled'}`);
});

elements.compressionLevel.addEventListener('change', (e) => {
    compressionLevel = parseInt(e.target.value);
    log(`Compression level set to ${compressionLevel}`);
});

elements.fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        elements.fileText.textContent = `${file.name} (${formatBytes(file.size)})`;
        elements.sendFileBtn.disabled = !dataChannel || dataChannel.readyState !== 'open';
    }
});

elements.sendFileBtn.addEventListener('click', sendFile);

elements.clearLogs.addEventListener('click', () => {
    elements.logOutput.innerHTML = '';
    log('Logs cleared');
});

// ===== Initialization =====
async function init() {
    log('Initializing WebRTC File Transfer...');

    try {
        await initZstd();
        log('Ready! Create an offer or paste a remote offer to get started.', 'success');
    } catch (error) {
        log(`Failed to initialize: ${error.message}`, 'error');
    }
}

init();
