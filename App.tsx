import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Settings, Mic, MicOff, Send, FileText, Upload, Trash2, Cpu, FileCheck, RefreshCw, HelpCircle, AlertTriangle, Zap, MessageSquare, Edit3, X, ChevronDown, Menu, ExternalLink, Moon, Sun, Copy, Check, Save, ToggleLeft, ToggleRight, Info, ScreenShare, ScreenShareOff, Plus, FilePlus, Wand2, Download, Monitor, Laptop, Terminal, LogOut, Lock, Crown } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { generateGemini, generateOpenAI, generateXAI, generateGroq } from './services/aiProxyService';
import { useSpeechRecognition } from './hooks/useSpeechRecognition';
import { extractTextFromPdf } from './services/pdfService';
import { useDatabase } from './hooks/useDatabase';
import { Message, AppSettings, ContextFile } from './types';
import { SubscriptionGate } from './SubscriptionGate';
import { licenseService, UserProfile, LicenseData } from './services/licenseService';
import './pip-styles.css';

// --- Electron Helpers ---
const isElectron = typeof window !== 'undefined' && !!(window as any).process?.versions?.electron;
const isPopoutMode = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('mode') === 'popout';

const electronIPC = {
  send: (channel: string, data?: any) => {
    if (isElectron) {
      try {
        const ipc = (window as any).require?.('electron')?.ipcRenderer;
        ipc?.send(channel, data);
      } catch (e) { console.warn('IPC send failed:', e); }
    }
  },
  on: (channel: string, callback: (data: any) => void) => {
    if (isElectron) {
      try {
        const ipc = (window as any).require?.('electron')?.ipcRenderer;
        ipc?.on(channel, (_event: any, data: any) => callback(data));
      } catch (e) { console.warn('IPC on failed:', e); }
    }
  }
};

// --- Helper: Code Block Renderer ---

const CodeBlock: React.FC<{ code: string; language: string }> = ({ code, language }) => {
    const [copied, setCopied] = useState(false);

    const handleCopy = () => {
        navigator.clipboard.writeText(code);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="my-3 rounded-lg overflow-hidden border border-gray-700/50 bg-black/20 backdrop-blur-sm shadow-lg">
            <div className="flex items-center justify-between px-4 py-2 bg-black/40 border-b border-gray-700/50">
                <span className="text-xs font-mono text-gray-400 lowercase">{language || 'code'}</span>
                <button 
                    onClick={handleCopy} 
                    className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white transition-colors"
                >
                    {copied ? <Check size={12} className="text-green-400"/> : <Copy size={12} />}
                    {copied ? "Copied" : "Copy"}
                </button>
            </div>
            <div className="p-4 overflow-x-auto bg-transparent">
                <SyntaxHighlighter
                    language={language || 'text'}
                    style={vscDarkPlus}
                    customStyle={{ margin: 0, padding: 0, background: 'transparent' }}
                    wrapLines={true}
                >
                    {code.trim()}
                </SyntaxHighlighter>
            </div>
        </div>
    );
};

const MessageRenderer = ({ content, fontSize }: { content: string, fontSize: string }) => {
    // Font size mapping
    const sizeClass = 
        fontSize === 'small' ? 'prose-sm' : 
        fontSize === 'large' ? 'prose-lg' : 
        'prose-base';

    return (
        <div className={`markdown-body prose dark:prose-invert max-w-none ${sizeClass} prose-pre:bg-transparent prose-pre:p-0 prose-pre:m-0`}>
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                    code({ node, inline, className, children, ...props }: any) {
                        const match = /language-(\w+)/.exec(className || '');
                        return !inline && match ? (
                            <CodeBlock code={String(children).replace(/\n$/, '')} language={match[1]} />
                        ) : (
                            <code className="bg-gray-200 dark:bg-gray-800 rounded px-1 py-0.5 font-mono text-sm" {...props}>
                                {children}
                            </code>
                        );
                    }
                }}
            >
                {content}
            </ReactMarkdown>
        </div>
    );
};

// --- Components ---

const Modal = ({ isOpen, onClose, title, children }: any) => {
  if (!isOpen) return null;
  const inElectron = typeof window !== 'undefined' && !!(window as any).process?.versions?.electron;
  return (
    <div 
      className="fixed inset-0 flex items-center justify-center p-4"
      style={{ 
        background: inElectron ? 'rgba(0,0,0,0.92)' : 'rgba(0,0,0,0.5)',
        zIndex: 99999,  // Above everything including screen-saver level content
        WebkitAppRegion: 'no-drag' as any,  // Ensure clicks work in frameless window
      }}
      onClick={onClose}
    >
      <div 
        className="border border-border rounded-xl w-full max-w-lg max-h-[85vh] flex flex-col shadow-2xl overflow-hidden text-text"
        style={{ background: inElectron ? '#1a1a2e' : 'var(--surface-color)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-border flex justify-between items-center bg-gray-500/5">
          <h2 className="text-lg font-bold flex items-center gap-2">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-primary transition-colors p-1 rounded-full hover:bg-gray-500/10">
             <X size={20} />
          </button>
        </div>
        <div className="p-4 overflow-y-auto custom-scrollbar flex-1">
          {children}
        </div>
      </div>
    </div>
  );
};

// Extracted for re-use between Main Window and PiP Window
const ChatInterface = ({ 
    messages, 
    settings, 
    setSettings, // Added to allow model switching from main UI
    isListening, 
    isProcessing, 
    inputText, 
    setInputText, 
    interimText, 
    speechError, 
    toggleAutoSend, 
    startListening, 
    stopListening, 
    handleManualSend, 
    handleAutoSolve,
    handleClear, 
    handleRegenerate,
    chatContainerRef,
    textareaRef,
    handleScroll,
    onOpenSettings,
    onOpenContext,
    onOpenHelp,
    onOpenDownload,
    isPipMode,
    togglePip,
    onNewSession,
    userProfile,
    userLicense,
    onLogout,
    gate
}: any) => {

    const handleModelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const newModel = e.target.value as 'gemini' | 'groq' | 'openai' | 'xai';
        // ── Feature Gate: Block model switch for free users ──
        if (!gate.canUseModel(newModel)) return;
        // Immediate state update
        const newSettings = {
            ...settings,
            selectedModel: newModel
        };
        setSettings(newSettings);
        // Persist immediately
        localStorage.setItem("SELECTED_MODEL", newModel);
    };

    // Pop-out size presets: S → M → L cycle
    const sizePresets = [
        { label: 'S', w: 340, h: 480 },
        { label: 'M', w: 450, h: 700 },
        { label: 'L', w: 580, h: 850 },
    ];
    const [sizeIndex, setSizeIndex] = useState(1); // Start at M

    if (isPipMode) {
        // Detect Electron for window controls
        const inElectron = typeof window !== 'undefined' && !!(window as any).process?.versions?.electron;

        const cycleSize = () => {
            const next = (sizeIndex + 1) % sizePresets.length;
            setSizeIndex(next);
            electronIPC.send('resize-popout', { width: sizePresets[next].w, height: sizePresets[next].h });
        };

        // Shared button style for glass look
        const glassBtn = {
            background: 'transparent',
            border: '1px solid var(--glass-border)',
            color: 'var(--text-main)',
        };

        return (
            <div className="popup open" style={inElectron ? { background: 'transparent' } : undefined}>
                <div className="bg-layer"></div>
                
                {/* ── HEADER ── */}
                <div 
                    className="popup-header" 
                    id="dragHandle"
                    style={inElectron ? { WebkitAppRegion: 'drag', padding: '10px 12px' } as any : undefined}
                >
                    {/* Left: Avatar + Name */}
                    <div className="avatar">✦</div>
                    <div className="header-info" style={{ minWidth: 0 }}>
                        <h4>minicaai</h4>
                        <span><span className="dot"></span> Online</span>
                    </div>

                    {/* Right: Controls row */}
                    <div 
                        className="ml-auto flex items-center" 
                        style={inElectron ? { WebkitAppRegion: 'no-drag', gap: '6px' } as any : { gap: '6px' }}
                    >
                        {/* Model selector — compact */}
                        <select
                            value={settings.selectedModel}
                            onChange={handleModelChange}
                            className="text-[10px] rounded px-1.5 py-0.5 outline-none cursor-pointer"
                            style={glassBtn}
                        >
                            <option value="gemini" className="text-black">Gemini</option>
                            <option value="groq" disabled={!gate.canUseModel('groq')} className="text-black">Groq{!gate.canUseModel('groq') ? ' 🔒' : ''}</option>
                            <option value="openai" disabled={!gate.canUseModel('openai')} className="text-black">GPT{!gate.canUseModel('openai') ? ' 🔒' : ''}</option>
                            <option value="xai" disabled={!gate.canUseModel('xai')} className="text-black">Grok{!gate.canUseModel('xai') ? ' 🔒' : ''}</option>
                        </select>

                        {/* Settings */}
                        <button onClick={onOpenSettings} className="p-1 rounded transition-colors hover:bg-white/10" title="Settings" style={glassBtn}>
                            <Settings size={13} strokeWidth={1.5} />
                        </button>

                        {/* ── Electron-only controls ── */}
                        {inElectron && (
                            <>
                                {/* Divider */}
                                <div style={{ width: 1, height: 16, background: 'var(--glass-border)', margin: '0 2px' }} />

                                {/* Size cycle: S → M → L */}
                                <button 
                                    onClick={cycleSize} 
                                    className="rounded transition-colors hover:bg-white/10"
                                    title={`Resize (now ${sizePresets[sizeIndex].label})`}
                                    style={{ ...glassBtn, padding: '2px 6px', fontSize: '10px', fontWeight: 700, letterSpacing: '0.5px' }}
                                >
                                    {sizePresets[sizeIndex].label}
                                </button>

                                {/* Minimize */}
                                <button 
                                    onClick={() => electronIPC.send('minimize-window')} 
                                    className="p-1 rounded transition-colors hover:bg-white/10" 
                                    title="Minimize"
                                    style={glassBtn}
                                >
                                    <svg width="12" height="12" viewBox="0 0 12 12"><line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                                </button>

                                {/* Close */}
                                <button 
                                    onClick={() => electronIPC.send('close-window')} 
                                    className="p-1 rounded transition-colors hover:bg-red-500/30" 
                                    title="Close"
                                    style={glassBtn}
                                >
                                    <X size={13} strokeWidth={1.5} />
                                </button>
                            </>
                        )}
                    </div>
                </div>

                <div 
                    className="messages" 
                    id="messages"
                    ref={chatContainerRef} 
                    onScroll={handleScroll}
                >
                    {messages.length === 0 && (
                        <div className="flex flex-col items-center justify-center h-full space-y-4 opacity-80 mt-10" style={{ color: 'var(--text-muted)' }}>
                            <div className="w-16 h-16 rounded-full flex items-center justify-center relative border border-current" style={{ background: 'var(--bubble-user)' }}>
                                {isListening ? <ScreenShare size={24} strokeWidth={1.5} className="animate-pulse" style={{ color: 'var(--text-main)' }} /> : <ScreenShareOff size={24} strokeWidth={1.5} />}
                                {settings.autoSend && <div className="absolute top-0 right-0 w-3 h-3 rounded-full border-2" style={{ background: 'var(--text-main)', borderColor: 'var(--glass-bg)' }}></div>}
                            </div>
                            <div className="text-center px-4">
                                <p className="font-medium mb-1 text-sm" style={{ color: 'var(--text-main)' }}>System Audio Copilot</p>
                                <p className="text-xs leading-relaxed max-w-xs mx-auto">
                                    Click the Mic button to share your screen tab.
                                </p>
                            </div>
                        </div>
                    )}

                    {messages.map((msg: Message) => (
                        <div key={msg.id} className={`msg ${msg.role === 'user' ? 'user' : 'ai'}`}>
                            <span className="msg-name">{msg.role === 'user' ? 'You' : 'minicaai'}</span>
                            <div className="bubble">
                                <MessageRenderer content={msg.content} fontSize={settings.fontSize} />
                            </div>
                            <span className="msg-time">{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                    ))}

                    {isProcessing && (
                        <div className="msg ai" id="typing">
                            <span className="msg-name">minicaai</span>
                            <div className="bubble typing-bubble">
                                <span className="typing-dot"></span>
                                <span className="typing-dot"></span>
                                <span className="typing-dot"></span>
                            </div>
                        </div>
                    )}
                </div>

                <div className="input-area" style={{ flexDirection: 'column', gap: '0' }}>
                    {/* ── Control strip: AUTO, MIC, LIVE status ── */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 8px', borderBottom: '1px solid var(--glass-border)' }}>
                        <button
                            onClick={toggleAutoSend}
                            style={{
                                background: settings.autoSend ? 'rgba(59,130,246,0.2)' : 'transparent',
                                border: `1px solid ${settings.autoSend ? 'rgba(59,130,246,0.4)' : 'var(--glass-border)'}`,
                                color: settings.autoSend ? '#3b82f6' : 'var(--text-muted)',
                                padding: '3px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px'
                            }}
                        >
                            <Zap size={10} /> {settings.autoSend ? 'AUTO' : 'MANUAL'}
                        </button>

                        <button
                            onClick={isListening ? stopListening : startListening}
                            style={{
                                background: isListening ? 'rgba(239,68,68,0.2)' : 'transparent',
                                border: `1px solid ${isListening ? 'rgba(239,68,68,0.4)' : 'var(--glass-border)'}`,
                                color: isListening ? '#ef4444' : 'var(--text-muted)',
                                padding: '3px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px'
                            }}
                        >
                            {isListening ? <Mic size={10} /> : <MicOff size={10} />}
                            {isListening ? 'LIVE' : 'MIC OFF'}
                        </button>

                        {speechError && (
                            <span style={{ fontSize: '9px', color: '#ef4444', marginLeft: 'auto', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {speechError}
                            </span>
                        )}
                    </div>

                    {/* ── Input row ── */}
                    <div style={{ display: 'flex', alignItems: 'flex-end', gap: '8px', padding: '8px' }}>
                    <div className="input-wrap">
                        <textarea 
                            id="inputBox" 
                            className="pip-textarea"
                            placeholder={settings.autoSend ? "Listening for interviewer..." : "Type a message…"}
                            rows={1}
                            value={inputText}
                            onChange={(e) => {
                                setInputText(e.target.value);
                                e.target.style.height = 'auto';
                                e.target.style.height = Math.min(e.target.scrollHeight, 110) + 'px';
                            }}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    handleManualSend();
                                }
                            }}
                        />
                    </div>
                    
                    <button 
                        className="send-btn" 
                        id="sendBtn" 
                        aria-label="Send message"
                        onClick={handleManualSend}
                        disabled={!inputText.trim() || isProcessing}
                        style={{ opacity: (!inputText.trim() || isProcessing) ? 0.5 : 1 }}
                    >
                        <Send size={18} strokeWidth={1.5} />
                    </button>
                    
                    <button
                        className="send-btn ml-2"
                        aria-label={gate.canAutoSolve ? "Auto-Solve" : "Auto-Solve — Pro only"}
                        onClick={handleAutoSolve}
                        disabled={isProcessing || !gate.canAutoSolve}
                        title={gate.canAutoSolve ? "Auto-Solve Screen" : "Auto-Solve — Pro only 🔒"}
                        style={{ opacity: (isProcessing || !gate.canAutoSolve) ? 0.4 : 1, position: 'relative' }}
                    >
                        <Wand2 size={18} strokeWidth={1.5} />
                    </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className={`flex-1 flex flex-col h-full overflow-hidden relative bg-transparent text-text transition-colors duration-300 ${settings.theme === 'dark' ? 'dark' : ''}`}>
             {/* --- RESPONSIVE HEADER --- */}
            <header className={`h-14 md:h-16 border-b border-white/15 bg-transparent flex items-center justify-between px-4 shrink-0 z-20 sticky top-0`}>
                <div className="flex items-center gap-2 md:gap-3">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
                    <Cpu size={18} className="text-white" />
                </div>
                <h1 className="font-bold text-base md:text-lg tracking-tight hidden xs:block">minica<span className="text-blue-500">ai</span></h1>
                </div>

                <div className="flex items-center gap-2 md:gap-3">
                    {/* User tier badge */}
                    {userLicense && userLicense.tier === 'pro' ? (
                      <div className="hidden md:flex px-2.5 py-1 rounded-full text-[10px] font-bold items-center gap-1.5 border bg-blue-500/10 border-blue-500/30 text-blue-400">
                        <Crown size={10} /> PRO
                      </div>
                    ) : userLicense ? (
                      <button onClick={openProUpgrade} className="hidden md:flex px-3 py-1 rounded-full text-[10px] font-bold items-center gap-1.5 border bg-gradient-to-r from-blue-500/10 to-purple-500/10 border-blue-500/30 text-blue-400 hover:from-blue-500/20 hover:to-purple-500/20 transition-all cursor-pointer">
                        <Crown size={10} /> Upgrade to Pro
                      </button>
                    ) : null}
                    <div className={`hidden md:flex px-3 py-1 rounded-full text-xs font-medium items-center gap-2 border transition-all duration-300 ${isListening ? 'bg-red-500/10 border-red-500/50 text-red-500' : 'bg-surface border-border text-gray-500'}`}>
                        <div className={`w-2 h-2 rounded-full ${isListening ? 'bg-red-500 animate-pulse' : 'bg-gray-500'}`}></div>
                        {isListening ? 'LIVE' : 'OFF'}
                    </div>
                    
                    {!isPipMode && (
                        <button
                            onClick={togglePip}
                            className={`p-2 rounded-lg transition-all border relative ${
                              gate.canPopout
                                ? 'text-primary hover:bg-blue-500/10 border-blue-500/20'
                                : 'text-gray-500 border-gray-500/20 cursor-not-allowed opacity-60'
                            }`}
                            title={gate.canPopout ? "Pop Out (Hide from Screen Share)" : "Pop-out Mode — Pro only 🔒"}
                        >
                            <ExternalLink size={20} />
                            {!gate.canPopout && <Lock size={8} className="absolute top-1 right-1 text-amber-400" />}
                        </button>
                    )}

                    {onNewSession && (
                        <button onClick={onNewSession} className="p-2 text-gray-400 hover:text-green-400 hover:bg-green-500/10 border border-transparent hover:border-green-500/20 rounded-lg transition-all" title="New Interview Session"><Plus size={20} /></button>
                    )}
                    <button onClick={onOpenHelp} className="p-2 text-gray-400 hover:text-text hover:bg-surface border border-transparent hover:border-border rounded-lg transition-all" title="Audio Help"><HelpCircle size={20} /></button>
                    <button onClick={onOpenContext} className="p-2 text-gray-400 hover:text-text hover:bg-surface border border-transparent hover:border-border rounded-lg transition-all" title="Files (Knowledge Base)"><FileText size={20} /></button>
                    <button onClick={onOpenSettings} className={`p-2 rounded-lg transition-all border border-transparent hover:border-border text-gray-400 hover:text-text hover:bg-surface`} title="Settings"><Settings size={20} /></button>
                    <button onClick={onLogout} className="p-2 text-gray-400 hover:text-red-400 hover:bg-red-500/10 border border-transparent hover:border-red-500/20 rounded-lg transition-all" title="Logout"><LogOut size={20} /></button>
                </div>
            </header>

            <main className="flex-1 flex overflow-hidden relative w-full">
                <div className="flex-1 flex flex-col max-w-4xl mx-auto w-full relative">
                
                <div 
                    ref={chatContainerRef} 
                    onScroll={handleScroll}
                    className="flex-1 overflow-y-auto p-4 md:p-6 space-y-4 md:space-y-6 pb-40 md:pb-48 scroll-smooth custom-scrollbar"
                >
                    {messages.length === 0 && (
                        <div className="flex flex-col items-center justify-center h-[60%] text-gray-400 space-y-6 opacity-60 mt-10">
                            <div className="w-24 h-24 rounded-full bg-surface flex items-center justify-center relative ring-1 ring-border">
                                {isListening ? <ScreenShare size={40} className="text-red-500 animate-pulse" /> : <ScreenShareOff size={40} className="text-gray-500" />}
                                {settings.autoSend && <div className="absolute top-1 right-1 w-4 h-4 bg-green-500 rounded-full border-2 border-background shadow-[0_0_10px_rgba(34,197,94,0.5)]"></div>}
                            </div>
                            <div className="text-center px-6">
                                <p className="font-medium text-text mb-2 text-lg">System Audio Copilot</p>
                                <p className="text-sm leading-relaxed max-w-xs mx-auto text-gray-500">
                                    Click the Mic button to share your screen tab.<br/>
                                    <strong>Remember to check "Share tab audio"</strong>.
                                </p>
                            </div>
                        </div>
                    )}
                    
                    {messages.map((msg: Message) => (
                    <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} animate-in slide-in-from-bottom-2 duration-300`}>
                        <div className={`max-w-[95%] md:max-w-[85%] rounded-2xl p-3 md:p-5 shadow-lg ${
                        msg.role === 'user' 
                            ? 'bg-transparent text-text border border-white/20 rounded-tr-sm' 
                            : msg.role === 'system'
                            ? 'bg-transparent border border-red-500/50 text-red-500'
                            : 'bg-transparent border border-white/15 text-text rounded-tl-sm'
                        }`}>
                        <div className="text-[10px] font-bold mb-2 opacity-60 uppercase tracking-wider flex items-center gap-1">
                            {msg.role === 'user' ? <MessageSquare size={10} /> : <Zap size={10} />}
                            {msg.role === 'user' ? 'Transcript' : msg.role === 'system' ? 'System' : 'Answer'}
                        </div>
                        {/* Use Custom Message Renderer */}
                        <MessageRenderer content={msg.content} fontSize={settings.fontSize} />
                        </div>
                    </div>
                    ))}

                    {isProcessing && (
                    <div className="flex justify-start">
                        <div className="bg-transparent border border-white/15 rounded-2xl px-4 py-3 rounded-tl-sm flex items-center gap-2 text-gray-500 text-xs shadow-lg">
                            <span className="font-semibold text-primary tracking-wider">THINKING ({settings.selectedModel.toUpperCase()})</span>
                            <div className="flex gap-1">
                                <div className="w-1 h-1 bg-primary rounded-full animate-bounce" style={{ animationDelay: '0ms'}}></div>
                                <div className="w-1 h-1 bg-primary rounded-full animate-bounce" style={{ animationDelay: '150ms'}}></div>
                                <div className="w-1 h-1 bg-primary rounded-full animate-bounce" style={{ animationDelay: '300ms'}}></div>
                            </div>
                        </div>
                    </div>
                    )}
                </div>

                {/* --- INPUT BAR --- */}
                <div className="absolute bottom-0 left-0 right-0 bg-transparent pt-4 pb-4 px-2 md:px-6 z-20">
                    <div className="max-w-3xl mx-auto flex flex-col gap-2">
                        
                        {speechError && (
                            <div className="mx-auto bg-red-500/90 text-white px-3 py-1 rounded-full text-xs border border-red-400 flex items-center gap-2 shadow-lg backdrop-blur">
                                <AlertTriangle size={10} /> {speechError}
                            </div>
                        )}

                        <div className={`bg-transparent border rounded-2xl shadow-lg transition-all duration-300 flex flex-col ${isListening ? 'border-white/30' : 'border-white/15'}`}>
                            
                            <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-500/10">
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={toggleAutoSend}
                                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] md:text-xs font-bold transition-all border ${
                                            settings.autoSend 
                                            ? 'bg-blue-500/20 text-blue-500 border-blue-500/30' 
                                            : 'bg-gray-500/10 text-gray-500 border-transparent'
                                        }`}
                                    >
                                        <Zap size={12} className={settings.autoSend ? "fill-blue-500" : ""} />
                                        {settings.autoSend ? 'AUTO' : 'MANUAL'}
                                    </button>

                                    <button
                                        onClick={isListening ? stopListening : startListening}
                                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] md:text-xs font-bold transition-all border ${
                                            isListening 
                                            ? 'bg-red-500/20 text-red-500 border-red-500/30' 
                                            : 'bg-gray-500/10 text-gray-500 border-transparent'
                                        }`}
                                    >
                                        {isListening ? <Mic size={12} /> : <MicOff size={12} />}
                                        {isListening ? 'ON' : 'OFF'}
                                    </button>

                                    {/* --- QUICK MODEL SWITCHER --- */}
                                    <div className="h-5 w-[1px] bg-gray-500/20 mx-1"></div>
                                    <div className="relative group">
                                        <select
                                            value={settings.selectedModel}
                                            onChange={handleModelChange}
                                            className="appearance-none bg-surface text-text text-[10px] md:text-xs font-bold px-2.5 py-1 pr-6 rounded-md border border-border hover:border-primary focus:outline-none focus:ring-1 focus:ring-primary transition-all cursor-pointer"
                                        >
                                            <option value="gemini" className="bg-white dark:bg-gray-800 text-black dark:text-white">Gemini 3.1 Flash</option>
                                            <option value="groq" disabled={!gate.canUseModel('groq')} className="bg-white dark:bg-gray-800 text-black dark:text-white">Groq{!gate.canUseModel('groq') ? ' 🔒' : ''}</option>
                                            <option value="openai" disabled={!gate.canUseModel('openai')} className="bg-white dark:bg-gray-800 text-black dark:text-white">GPT-5.4 Mini{!gate.canUseModel('openai') ? ' 🔒' : ''}</option>
                                            <option value="xai" disabled={!gate.canUseModel('xai')} className="bg-white dark:bg-gray-800 text-black dark:text-white">Grok (xAI){!gate.canUseModel('xai') ? ' 🔒' : ''}</option>
                                        </select>
                                        <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-gray-500">
                                            <ChevronDown size={10} />
                                        </div>
                                    </div>
                                </div>
                                
                                {!isProcessing && messages.length > 0 && (
                                    <button onClick={handleRegenerate} className="text-gray-500 hover:text-primary transition-colors p-1" title="Regenerate last answer">
                                        <RefreshCw size={14} />
                                    </button>
                                )}
                            </div>

                            <div className="relative p-2 flex items-end gap-2">
                                <div className="relative flex-1 min-w-0">
                                    {interimText && (
                                        <div className="absolute top-2.5 left-3 text-gray-400 pointer-events-none text-sm md:text-base whitespace-pre-wrap truncate w-full opacity-60 italic z-0">
                                            {inputText}{interimText}
                                        </div>
                                    )}
                                    <textarea
                                        ref={textareaRef}
                                        value={inputText}
                                        onChange={(e) => setInputText(e.target.value)}
                                        placeholder={settings.autoSend ? "Listening for interviewer..." : "Type or speak context..."}
                                        className="w-full bg-transparent text-text placeholder-gray-500 px-3 py-2.5 focus:outline-none rounded-xl text-sm md:text-base leading-relaxed resize-none z-10 relative custom-scrollbar max-h-[150px] overflow-y-auto"
                                        rows={1}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && !e.shiftKey) {
                                                e.preventDefault();
                                                handleManualSend();
                                            }
                                        }}
                                    />
                                </div>

                                <div className="flex flex-col gap-1 pb-1">
                                    {inputText && (
                                        <button onClick={handleClear} className="p-2 text-gray-400 hover:text-red-400 rounded-lg hover:bg-gray-500/10 transition-colors">
                                            <X size={18} />
                                        </button>
                                    )}
                                    <div className="flex gap-1">
                                        <button
                                            onClick={handleAutoSolve}
                                            disabled={isProcessing || !gate.canAutoSolve}
                                            title={gate.canAutoSolve ? "Auto-Solve Screen" : "Auto-Solve — Pro only"}
                                            className={`p-2 rounded-xl transition-all shadow-lg relative ${
                                                !gate.canAutoSolve
                                                ? 'bg-gray-600/30 text-gray-500 cursor-not-allowed border border-gray-500/20'
                                                : !isProcessing
                                                ? 'bg-purple-600 text-white hover:bg-purple-700'
                                                : 'bg-surface text-gray-500 cursor-not-allowed border border-border'
                                            }`}
                                        >
                                            <Wand2 size={18} />
                                            {!gate.canAutoSolve && <Lock size={8} className="absolute top-1 right-1 text-amber-400" />}
                                        </button>
                                        <button 
                                            onClick={handleManualSend}
                                            disabled={!inputText.trim() || isProcessing}
                                            className={`p-2 rounded-xl transition-all shadow-lg ${
                                                inputText.trim() && !isProcessing
                                                ? 'bg-primary text-white hover:bg-blue-600' 
                                                : 'bg-surface text-gray-500 cursor-not-allowed border border-border'
                                            }`}
                                        >
                                            <Send size={18} />
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                </div>
            </main>
        </div>
    );
};

// PiP Window Logic
const PiPWindow: React.FC<{ children: React.ReactNode; onClose: () => void }> = ({ children, onClose }) => {
    const [container, setContainer] = useState<HTMLElement | null>(null);

    useEffect(() => {
        if (!window.documentPictureInPicture) {
            alert("Your browser does not support Document Picture-in-Picture (Pop-out). Please use Chrome 111+ or Edge.");
            onClose();
            return;
        }

        async function initPip() {
            try {
                // Request a vertical phone-like window
                const pipWindow = await window.documentPictureInPicture.requestWindow({
                    width: 450,
                    height: 700,
                });

                // Copy styles from main document to PiP
                [...document.styleSheets].forEach((styleSheet) => {
                    try {
                        const cssRules = [...styleSheet.cssRules]
                        .map((rule) => rule.cssText)
                        .join("");
                        const style = document.createElement("style");
                        style.textContent = cssRules;
                        pipWindow.document.head.appendChild(style);
                    } catch (e) {
                    const link = document.createElement("link");
                    link.rel = "stylesheet";
                    link.type = styleSheet.type;
                    link.media = styleSheet.media.mediaText;
                    link.href = styleSheet.href;
                    pipWindow.document.head.appendChild(link);
                    }
                });
                
                // Add Tailwind CDN directly to be sure
                const twScript = pipWindow.document.createElement('script');
                twScript.src = "https://cdn.tailwindcss.com";
                twScript.onload = () => {
                     // Re-inject config
                     const configScript = pipWindow.document.createElement('script');
                     configScript.innerHTML = `
                      tailwind.config = {
                        darkMode: 'class',
                        theme: {
                          extend: {
                            colors: {
                              background: 'var(--bg-color)',
                              surface: 'var(--surface-color)',
                              border: 'var(--border-color)',
                              text: 'var(--text-color)',
                              primary: '#3b82f6',
                              accent: '#f59e0b',
                            },
                          },
                        },
                      }
                   `;
                   pipWindow.document.head.appendChild(configScript);
                };
                pipWindow.document.head.appendChild(twScript);

                // Inject CSS Vars
                 const style = pipWindow.document.createElement('style');
                style.textContent = `
                 :root { --bg-color: #000000; --surface-color: rgba(25, 25, 25, 0.5); --border-color: rgba(255, 255, 255, 0.1); --text-color: #ffffff; }
                 .dark { --bg-color: #000000; --surface-color: rgba(25, 25, 25, 0.5); --border-color: rgba(255, 255, 255, 0.1); --text-color: #ffffff; }
                 body { background-color: var(--bg-color); color: var(--text-color); }
                 .pip-body { background: #000000; }
                `;
                pipWindow.document.head.appendChild(style);

                pipWindow.document.body.className = 'pip-body';

                const div = pipWindow.document.createElement('div');
                div.style.height = '100%';
                div.style.display = 'flex';
                div.style.flexDirection = 'column';
                // Force dark mode if main app is dark, else light
                if (document.documentElement.classList.contains('dark')) {
                    div.classList.add('dark');
                }
                pipWindow.document.body.appendChild(div);
                setContainer(div);

                pipWindow.addEventListener("pagehide", () => {
                    onClose();
                });
            } catch (err) {
                console.error("PiP Error:", err);
                onClose();
            }
        }
        initPip();
    }, []);

    if (!container) return null;
    return createPortal(children, container);
};


import { FEATURE_GATES } from './services/licenseService';

// ── Feature Gate Helper ──
function useFeatureGate(license: LicenseData | null) {
  const tier = license?.tier === 'pro' ? 'pro' : 'free';
  const gates = FEATURE_GATES[tier];

  return {
    tier,
    isPro: tier === 'pro',
    isFree: tier === 'free',
    allowedModels: gates.models,
    canScreenCapture: gates.screenCapture,
    canAutoSolve: gates.autoSolve,
    canPopout: gates.popout,
    maxContextFiles: gates.contextFiles,
    maxSessions: gates.sessionsPerMonth,
    canExportHistory: gates.exportHistory,
    canUseModel: (model: string) => gates.models.includes(model),
    getDefaultModel: () => gates.models[0] || 'gemini',
  };
}

// ── Upgrade to Pro — opens Stripe checkout in browser ──
async function openProUpgrade() {
  const { licenseService } = await import('./services/licenseService');
  const token = licenseService.getToken();
  if (!token) {
    alert('Please sign in first.');
    return;
  }
  try {
    // Use the user's actual country code for geo-routed payments (Stripe vs Razorpay)
    const saved = licenseService.loadAuth();
    const countryCode = saved.user?.country_code || 'US';

    const response = await fetch('https://h2so4-production.up.railway.app/api/v1/payments/create-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ country_code: countryCode }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Failed to start checkout');
    if (data.checkout_url) {
      // Open in default browser (works in Electron and web)
      if (typeof window !== 'undefined' && (window as any).require) {
        (window as any).require('electron').shell.openExternal(data.checkout_url);
      } else {
        window.open(data.checkout_url, '_blank');
      }
    }
  } catch (err: any) {
    alert(`Upgrade failed: ${err.message || 'Unknown error'}. Please try again.`);
  }
}

// ── Pro Feature Locked Overlay ──
const ProFeatureLocked = ({ feature, compact }: { feature: string; compact?: boolean }) => (
  <div className={`flex items-center gap-1.5 ${compact ? 'text-[10px]' : 'text-xs'} text-amber-400/80`}>
    <Lock size={compact ? 10 : 12} />
    <span>Pro only{!compact && ` — ${feature}`}</span>
  </div>
);

function MainApp({ userProfile, userLicense, onLogout }: { userProfile: UserProfile | null; userLicense: LicenseData | null; onLogout: () => void }) {
  // --- Feature Gates ---
  const gate = useFeatureGate(userLicense);

  // --- Database-backed state (Electron) / local fallback (browser) ---
  const db = useDatabase();
  const messages = db.messages;
  const setMessages = db.setMessages;
  const messagesRef = useRef<Message[]>([]);
  const contextFilesRef = useRef<ContextFile[]>([]);

  // Keep messagesRef in sync with messages
  useEffect(() => {
      messagesRef.current = messages;
  }, [messages]);

  // Keep contextFilesRef in sync with db.contextFiles
  useEffect(() => {
      contextFilesRef.current = db.contextFiles;
  }, [db.contextFiles]);
  const [inputText, setInputText] = useState("");
  const [interimText, setInterimText] = useState("");
  
  const [isProcessing, setIsProcessing] = useState(false);
  const streamRef = useRef<MediaStream | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  
  // Local state for Quick Paste in Context Modal
  const [pasteContent, setPasteContent] = useState("");
  
  // PiP State — auto-enter if this is the Electron pop-out window
  const [isPipMode, setIsPipMode] = useState(isPopoutMode);

  // Electron pop-out window: make transparent + set up cross-window sync
  useEffect(() => {
    if (isElectron && isPopoutMode) {
      document.documentElement.classList.add('electron-transparent');
      document.body.style.background = 'transparent';
    }
    // Listen for popout closed (main window gets notified)
    if (isElectron && !isPopoutMode) {
      electronIPC.on('popout-closed', () => {
        setIsPipMode(false);
      });
      electronIPC.on('popout-opened', () => {
        setIsPipMode(true);
      });
    }
    return () => {
      document.documentElement.classList.remove('electron-transparent');
    };
  }, []);

  // Settings State
  const [settings, setSettings] = useState<AppSettings>({
    selectedModel: (() => {
      const saved = (localStorage.getItem("SELECTED_MODEL") as 'gemini'|'groq'|'openai'|'xai') || 'gemini';
      if (!gate.canUseModel(saved)) return gate.getDefaultModel() as 'gemini'|'groq'|'openai'|'xai';
      return saved;
    })(),
    autoSend: false,
    contextFiles: [],
    theme: (localStorage.getItem("THEME") as 'light'|'dark') || 'dark',
    fontSize: (localStorage.getItem("FONT_SIZE") as 'small'|'medium'|'large') || 'medium',
    generalMode: localStorage.getItem("GENERAL_MODE") === 'true',
  });

  // Settings Modal Local State
  const [tempModel, setTempModel] = useState<'gemini'|'groq'|'openai'|'xai'>('gemini');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved'>('idle');

  // Ref for file input to ensure reliable click
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Ref pattern to fix closure staleness in callbacks
  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  // Apply Theme to HTML root
  useEffect(() => {
      const root = document.documentElement;
      if (settings.theme === 'dark') {
          root.classList.add('dark');
      } else {
          root.classList.remove('dark');
      }
      localStorage.setItem("THEME", settings.theme);
  }, [settings.theme]);

  // Apply General Mode persistence
  useEffect(() => {
      localStorage.setItem("GENERAL_MODE", String(settings.generalMode));
  }, [settings.generalMode]);

  // Sync temp state when settings open
  useEffect(() => {
      if (showSettings) {
          setTempModel(settings.selectedModel);
          setSaveStatus('idle');
      }
  }, [showSettings, settings.selectedModel]);


  // Scroll State
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);

  const chatContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const silenceTimerRef = useRef<any>(null);
  const inputTextRef = useRef(inputText);

  useEffect(() => {
    inputTextRef.current = inputText;
    if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        const newHeight = Math.min(textareaRef.current.scrollHeight, 150);
        textareaRef.current.style.height = newHeight + 'px';
    }
  }, [inputText]);

  // API keys are now managed server-side — no client init needed

  // Handle Auto-Scrolling
  useEffect(() => {
    if (shouldAutoScroll && chatContainerRef.current) {
      chatContainerRef.current.scrollTo({
          top: chatContainerRef.current.scrollHeight,
          behavior: 'smooth'
      });
    }
  }, [messages, interimText, shouldAutoScroll]);

  // Pop-out: re-enable auto-scroll when new messages arrive (since executeSend doesn't run here)
  useEffect(() => {
    if (isPopoutMode && messages.length > 0) {
      setShouldAutoScroll(true);
    }
  }, [messages.length]);

  const handleScroll = () => {
      if (!chatContainerRef.current) return;
      const { scrollTop, scrollHeight, clientHeight } = chatContainerRef.current;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
      setShouldAutoScroll(isAtBottom);
  };

  // --- Core Logic ---
  const executeSend = useCallback(async (textToSend: string, imageBase64?: string) => {
      if (!textToSend.trim()) return;

      // ── Feature Gate: Block disallowed models ──
      const currentModel = settingsRef.current.selectedModel;
      if (!gate.canUseModel(currentModel)) {
        const fallback = gate.getDefaultModel();
        setSettings(prev => ({ ...prev, selectedModel: fallback as any }));
        localStorage.setItem("SELECTED_MODEL", fallback);
        // Notify user
        const gateMsg: Message = {
          id: Date.now().toString(),
          role: 'model',
          content: `⚠️ **${currentModel.charAt(0).toUpperCase() + currentModel.slice(1)}** is a Pro-only model. Switched to **${fallback.charAt(0).toUpperCase() + fallback.slice(1)}**. Upgrade to Pro to unlock all AI models.`,
          timestamp: Date.now()
        };
        if (db.isElectron) { db.addMessage(gateMsg); } else { setMessages(prev => [...prev, gateMsg]); }
        return;
      }

      const userMsg: Message = {
        id: Date.now().toString(),
        role: 'user',
        content: textToSend,
        timestamp: Date.now()
      };

      if (db.isElectron) {
        db.addMessage(userMsg);
      } else {
        setMessages(prev => [...prev, userMsg]);
      }
      setIsProcessing(true);
      setInterimText("");
      setInputText("");
      setShouldAutoScroll(true);

      try {
        const currentSettings = settingsRef.current;
        let contextFiles = contextFilesRef.current;

        // Only include a screen capture if one was explicitly passed (e.g. from Auto-Solve)
        if (imageBase64) {
            contextFiles = [...contextFiles, {
                id: 'temp-screen-capture',
                name: 'Screen Capture',
                content: '[Binary File]',
                type: 'custom',
                mimeType: 'image/jpeg',
                base64: imageBase64
            }];
        }
        let responseText = "";

        // Route request through server proxy based on selected model
        const generators: Record<string, Function> = { groq: generateGroq, openai: generateOpenAI, xai: generateXAI, gemini: generateGemini };
        const gen = generators[currentSettings.selectedModel] || generateGemini;
        responseText = await gen(userMsg.content, messagesRef.current, contextFiles, currentSettings.generalMode);
        
        if (responseText !== "Listening...") {
            const aiMsg: Message = {
              id: (Date.now() + 1).toString(),
              role: 'model',
              content: responseText,
              timestamp: Date.now()
            };
            if (db.isElectron) {
              db.addMessage(aiMsg);
            } else {
              setMessages(prev => [...prev, aiMsg]);
            }
        }
      } catch (err) {
        console.error(err);
        const errorMsg: Message = {
          id: Date.now().toString(),
          role: 'system',
          content: "Error generating response. Check API Key.",
          timestamp: Date.now()
        };
        if (db.isElectron) {
          db.addMessage(errorMsg);
        } else {
          setMessages(prev => [...prev, errorMsg]);
        }
      } finally {
        setIsProcessing(false);
      }
  }, []); 

  // --- Speech Handling ---
  const handleSpeechResult = useCallback(({ final, interim }: { final: string, interim: string }) => {
    setInterimText(interim);
    if (interim && silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
    }
    if (final) {
        // --- NOISE GATE / FILLER FILTER ---
        // 1. Clean punctuation for matching
        const raw = final.trim().toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,"");
        
        // 2. Extended Filler Dictionary
        const IGNORED_PHRASES = new Set([
            "ok", "okay", "k", "kk", "alright", "right", "sure", "yeah", "yep", "yup", "yes",
            "cool", "nice", "great", "awesome", "perfect", "fine", "good",
            "hmm", "hm", "mm", "mmm", "uh", "um", "huh", "ah", "er", "oh",
            "got it", "i see", "makes sense", "understood", "no problem", "no worries",
            "thank you", "thanks", "thanks a lot",
            "hello", "hi", "hey", "guys", "everyone",
            "bye", "goodbye", "see ya",
            "so", "and", "but", "or", "actually", "basically", "literally",
            "wait", "hold on", "one sec", "one second",
            "what", "really", "wow", "oh wow",
            "ok cool", "okay cool", "sounds good", "sounds great", "fair enough",
            "ok bye", "okay bye", "all good"
        ]);

        // 3. Regex for repeated characters (e.g. "hmmm", "ooookay", "umm")
        // Catches h+m+, u+m+, u+h+, o+k+, a+h+, e+r+
        const isRepeatedFiller = /^(h+m+|u+m+|u+h+|o+k+|a+h+|e+r+)$/.test(raw);

        // 4. Logic: Ignore if exact match, repeated filler pattern, or very short noise (<2 chars)
        const isIgnored = IGNORED_PHRASES.has(raw) || isRepeatedFiller || raw.length < 2;

        if (isIgnored) {
            console.log("Ignored filler/noise:", final);
            setInterimText(""); 
            return; // EXIT: Do not add to input text, do not send to AI.
        }
        // ----------------------------------

        setInputText(prev => {
            const separator = prev.length > 0 && !prev.endsWith(' ') ? " " : "";
            return prev + separator + final;
        });
        if (settingsRef.current.autoSend) {
            if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
            silenceTimerRef.current = setTimeout(() => {
                const currentBuffer = inputTextRef.current;
                if (currentBuffer && currentBuffer.trim().length > 0) {
                     executeSend(currentBuffer);
                }
            }, 1200); 
        }
    }
  }, [executeSend]);

  // ── Speech recognition — only runs in the main window, NOT the pop-out ──
  // Pop-out is a thin UI client: it relays actions to main and receives state via IPC.
  const isPopoutThinClient = isElectron && isPopoutMode;

  const { isListening: _rawIsListening, error: _rawSpeechError, startListening: _rawStartListening, stopListening: _rawStopListening, stream } = useSpeechRecognition({
    onResult: isPopoutThinClient ? () => {} : handleSpeechResult,
    onError: (err) => console.error("Speech Error:", err),
  });

  // Pop-out: shadow state received from main window via IPC
  const [remoteIsListening, setRemoteIsListening] = useState(false);
  const [remoteIsProcessing, setRemoteIsProcessing] = useState(false);
  const [remoteSpeechError, setRemoteSpeechError] = useState<string | null>(null);

  // Expose unified state — pop-out reads from remote, main reads from local
  const isListening = isPopoutThinClient ? remoteIsListening : _rawIsListening;
  const speechError = isPopoutThinClient ? remoteSpeechError : _rawSpeechError;

  useEffect(() => {
      streamRef.current = stream;
  }, [stream]);

  // ── Cross-window state sync (Electron only) ──
  // Main window → pop-out: relay state whenever it changes
  useEffect(() => {
    if (!isElectron || isPopoutMode) return;
    electronIPC.send('relay-to-popout', {
      type: 'state-sync',
      isListening: _rawIsListening,
      isProcessing,
      interimText,
      inputText,
      autoSend: settings.autoSend,
      speechError: _rawSpeechError,
    });
  }, [_rawIsListening, isProcessing, interimText, inputText, settings.autoSend, _rawSpeechError]);

  // Pop-out: receive state from main window
  useEffect(() => {
    if (!isPopoutThinClient) return;
    const ipc = (window as any).require?.('electron')?.ipcRenderer;
    if (!ipc) return;

    const handler = (_e: any, data: any) => {
      if (data?.type === 'state-sync') {
        setRemoteIsListening(data.isListening);
        setRemoteIsProcessing(data.isProcessing);
        setInterimText(data.interimText ?? '');
        setInputText(data.inputText ?? '');
        setRemoteSpeechError(data.speechError ?? null);
        setIsProcessing(data.isProcessing);
        setSettings(prev => prev.autoSend !== data.autoSend ? { ...prev, autoSend: data.autoSend } : prev);
      }
    };
    ipc.on('from-main', handler);
    electronIPC.send('relay-to-main', { type: 'request-state' });
    return () => ipc.removeListener('from-main', handler);
  }, []);

  // --- UI Actions (pop-out relays to main, main executes locally) ---
  const startListening = isPopoutThinClient
    ? () => electronIPC.send('relay-to-main', { type: 'cmd-start-listening' })
    : _rawStartListening;

  const stopListening = isPopoutThinClient
    ? () => electronIPC.send('relay-to-main', { type: 'cmd-stop-listening' })
    : _rawStopListening;

  const handleManualSend = () => {
    if (isPopoutThinClient) {
      if (!inputText.trim()) return;
      electronIPC.send('relay-to-main', { type: 'cmd-manual-send', text: inputText });
      setInputText('');
      return;
    }
    if (!inputText.trim() || isProcessing) return;
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    executeSend(inputText);
  };

  /**
   * One-shot screen capture — grabs a single frame and immediately releases resources.
   * Electron: fresh getUserMedia (video only), screenshot, stop tracks.
   * Browser: uses the existing display stream if video track is still alive.
   */
  const captureScreenshot = useCallback(async (): Promise<string | null> => {
    // ── Feature Gate: Screen capture is Pro only ──
    if (!gate.canScreenCapture) {
      console.warn('[FeatureGate] Screen capture blocked — free tier');
      return null;
    }

    let tempStream: MediaStream | null = null;
    try {
      let videoTrack: MediaStreamTrack | null = null;

      if (isElectron) {
        // Fresh one-shot capture in Electron
        const { ipcRenderer } = (window as any).require('electron');
        const sources = await ipcRenderer.invoke('get-desktop-sources');
        if (!sources || sources.length === 0) return null;

        const screenSource = sources.find((s: any) =>
          s.name === 'Entire Screen' || s.name === 'Screen 1' || s.name.toLowerCase().includes('screen')
        ) || sources[0];

        tempStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: screenSource.id,
              maxWidth: 1920,
              maxHeight: 1080,
              maxFrameRate: 5,
            }
          } as any,
        });
        videoTrack = tempStream.getVideoTracks()[0] || null;
      } else {
        // Browser: reuse existing stream's video track
        videoTrack = streamRef.current?.getVideoTracks()[0] || null;
      }

      if (!videoTrack || videoTrack.readyState !== 'live') return null;

      const video = document.createElement('video');
      video.srcObject = new MediaStream([videoTrack]);
      await video.play();

      let width = video.videoWidth;
      let height = video.videoHeight;
      const MAX_WIDTH = 1920;
      if (width > MAX_WIDTH) {
        height = Math.round((height * MAX_WIDTH) / width);
        width = MAX_WIDTH;
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx?.drawImage(video, 0, 0, width, height);

      const base64 = canvas.toDataURL('image/jpeg', 0.7).split(',')[1];

      // Cleanup DOM elements to prevent memory leaks
      video.pause();
      video.srcObject = null;
      video.remove();
      canvas.remove();

      return base64;
    } catch (err) {
      console.error("Screen capture failed:", err);
      return null;
    } finally {
      // Release the one-shot stream in Electron (don't touch the browser's ongoing stream)
      if (tempStream) {
        tempStream.getTracks().forEach(t => t.stop());
      }
    }
  }, []);

  // Main window: listen for commands from pop-out
  useEffect(() => {
    if (!isElectron || isPopoutMode) return;
    const ipc = (window as any).require?.('electron')?.ipcRenderer;
    if (!ipc) return;

    const handler = (_e: any, data: any) => {
      if (!data?.type) return;
      switch (data.type) {
        case 'cmd-start-listening':
          _rawStartListening();
          break;
        case 'cmd-stop-listening':
          _rawStopListening();
          break;
        case 'cmd-toggle-auto-send':
          setSettings(prev => ({ ...prev, autoSend: !prev.autoSend }));
          break;
        case 'cmd-manual-send':
          if (data.text?.trim()) executeSend(data.text);
          break;
        case 'cmd-auto-solve':
          captureScreenshot().then(screenshot => {
            executeSend(
              "Please analyze the code or problem visible on the screen and provide the solution.",
              screenshot || undefined
            );
          });
          break;
        case 'cmd-clear':
          setInputText('');
          if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
          break;
        case 'cmd-set-input':
          setInputText(data.text ?? '');
          break;
        case 'request-state':
          electronIPC.send('relay-to-popout', {
            type: 'state-sync',
            isListening: _rawIsListening,
            isProcessing,
            interimText,
            inputText,
            autoSend: settings.autoSend,
            speechError: _rawSpeechError,
          });
          break;
      }
    };
    ipc.on('from-popout', handler);
    return () => ipc.removeListener('from-popout', handler);
  }, [executeSend, captureScreenshot, _rawStartListening, _rawStopListening]);

  const handleAutoSolve = async () => {
    // ── Feature Gate: Auto-Solve is Pro only ──
    if (!gate.canAutoSolve) {
      const gateMsg: Message = {
        id: Date.now().toString(),
        role: 'model',
        content: '🔒 **Auto-Solve** is a Pro feature. [Upgrade to Pro](upgrade) to capture your screen and get instant AI solutions.',
        timestamp: Date.now()
      };
      if (db.isElectron) { db.addMessage(gateMsg); } else { setMessages(prev => [...prev, gateMsg]); }
      return;
    }

    if (isPopoutThinClient) {
      electronIPC.send('relay-to-main', { type: 'cmd-auto-solve' });
      return;
    }
    if (isProcessing) return;
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);

    // One-shot screen capture, then send with the image
    const screenshot = await captureScreenshot();
    executeSend(
      "Please analyze the code or problem visible on the screen and provide the solution.",
      screenshot || undefined
    );
  };

  const handleClear = () => {
      if (isPopoutThinClient) {
        electronIPC.send('relay-to-main', { type: 'cmd-clear' });
        return;
      }
      setInputText("");
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
  };

  const handleRegenerate = async () => {
    if (isProcessing) return;
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUserMsg) return;

    setIsProcessing(true);
    try {
        const historyForService = messages.filter(m => m.id !== lastUserMsg.id && m.role !== 'system');
        const currentSettings = settingsRef.current;
        const contextFiles = contextFilesRef.current;
        let responseText = "";

        const generators: Record<string, Function> = { groq: generateGroq, openai: generateOpenAI, xai: generateXAI, gemini: generateGemini };
        const gen = generators[currentSettings.selectedModel] || generateGemini;
        responseText = await gen(lastUserMsg.content, historyForService, contextFiles, currentSettings.generalMode);

        if (responseText !== "Listening...") {
            const aiMsg: Message = {
                id: Date.now().toString(),
                role: 'model',
                content: responseText,
                timestamp: Date.now()
            };
            setMessages(prev => [...prev, aiMsg]);
        }
    } catch (err) { console.error(err); } finally { setIsProcessing(false); }
  };

  const triggerFileUpload = () => {
    fileInputRef.current?.click();
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset input so same file can be selected again
    e.target.value = '';

    // ── Feature Gate: Context file limit ──
    if (gate.maxContextFiles !== -1 && db.contextFiles.length >= gate.maxContextFiles) {
      if (confirm(`Free plan allows up to ${gate.maxContextFiles} context file${gate.maxContextFiles === 1 ? '' : 's'}. Upgrade to Pro for unlimited files?`)) openProUpgrade();
      return;
    }

    // Check if it's likely a text file to allow text-based models (like OpenAI) to read it.
    const isText = file.type.startsWith('text/') ||
                   file.name.endsWith('.txt') ||
                   file.name.endsWith('.md') ||
                   file.name.endsWith('.js') ||
                   file.name.endsWith('.ts') ||
                   file.name.endsWith('.py') ||
                   file.name.endsWith('.json') ||
                   file.name.endsWith('.html') ||
                   file.name.endsWith('.css') ||
                   file.name.endsWith('.csv');

    const isPdf = file.type === 'application/pdf' || file.name.endsWith('.pdf');

    const reader = new FileReader();

    if (isPdf) {
        setIsProcessing(true);
        extractTextFromPdf(file).then(text => {
            const newFile: ContextFile = {
                id: Date.now().toString(),
                name: file.name,
                content: text,
                type: 'custom',
                mimeType: 'text/plain',
                base64: undefined
            };
            db.addContextFile(newFile);
        }).catch(err => {
            console.error(err);
            alert("Failed to extract text from PDF");
        }).finally(() => {
            setIsProcessing(false);
        });
    } else if (isText) {
        reader.onload = (event) => {
            const text = event.target?.result as string;
            const newFile: ContextFile = {
                id: Date.now().toString(),
                name: file.name,
                content: text,
                type: 'custom',
                mimeType: file.type || 'text/plain',
                base64: undefined
            };
            db.addContextFile(newFile);
        };
        reader.readAsText(file);
    } else {
        // Binary (Image/PDF)
        reader.onload = (event) => {
          const result = event.target?.result as string;
          const base64Data = result.split(',')[1];
          const mimeType = result.split(':')[1].split(';')[0];

          const newFile: ContextFile = {
            id: Date.now().toString(),
            name: file.name,
            content: "[Binary File]",
            type: 'custom',
            mimeType: mimeType,
            base64: base64Data
          };
          db.addContextFile(newFile);
        };
        reader.readAsDataURL(file);
    }
  };
  
  const handleAddPasteText = () => {
      if (!pasteContent.trim()) return;
      // ── Feature Gate: Context file limit ──
      if (gate.maxContextFiles !== -1 && db.contextFiles.length >= gate.maxContextFiles) {
        if (confirm(`Free plan allows up to ${gate.maxContextFiles} context file${gate.maxContextFiles === 1 ? '' : 's'}. Upgrade to Pro for unlimited files?`)) openProUpgrade();
        return;
      }
      const newFile: ContextFile = {
          id: Date.now().toString(),
          name: `Pasted Context ${db.contextFiles.length + 1}`,
          content: pasteContent,
          type: 'custom'
      };
      db.addContextFile(newFile);
      setPasteContent("");
  };

  const removeFile = (id: string) => {
    db.removeContextFile(id);
  };

  const toggleAutoSend = () => {
    if (isPopoutThinClient) {
      electronIPC.send('relay-to-main', { type: 'cmd-toggle-auto-send' });
      return;
    }
    setSettings(prev => ({ ...prev, autoSend: !prev.autoSend }));
  };
  
  const toggleGeneralMode = () => {
      setSettings(prev => ({ ...prev, generalMode: !prev.generalMode }));
  };

  const saveSettings = () => {
      const safeModel = gate.canUseModel(tempModel) ? tempModel : gate.getDefaultModel() as any;

      localStorage.setItem("SELECTED_MODEL", safeModel);
      localStorage.setItem("THEME", settings.theme);
      localStorage.setItem("FONT_SIZE", settings.fontSize);

      const newSettings: AppSettings = {
          ...settings,
          selectedModel: safeModel,
      };

      setSettings(newSettings);
      settingsRef.current = newSettings;

      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
  };

  // --- RENDER HELPERS ---

  const sharedProps = {
    messages, settings, setSettings, isListening, isProcessing, inputText, setInputText, interimText,
    speechError, toggleAutoSend, startListening, stopListening, handleManualSend, handleAutoSolve,
    handleClear, handleRegenerate, chatContainerRef, textareaRef, handleScroll,
    onOpenSettings: () => setShowSettings(true),
    onOpenContext: () => { console.log('Opening Context'); setShowContext(true); },
    onOpenHelp: () => setShowHelp(true),
    onOpenDownload: () => { if (!isElectron) setShowDownloadModal(true); },
    isPipMode,
    togglePip: () => {
      // ── Feature Gate: Popout is Pro only ──
      if (!gate.canPopout) {
        const gateMsg: Message = {
          id: Date.now().toString(),
          role: 'model',
          content: '🔒 **Pop-out Mode** is a Pro feature. Upgrade to Pro to use the invisible overlay during interviews.',
          timestamp: Date.now()
        };
        if (db.isElectron) { db.addMessage(gateMsg); } else { setMessages(prev => [...prev, gateMsg]); }
        return;
      }
      if (isElectron) {
        // In Electron: open a real transparent pop-out window
        electronIPC.send('open-popout', { width: 450, height: 700 });
      } else {
        setIsPipMode(true);
      }
    },
    isElectron,
    onNewSession: db.isElectron ? () => db.newSession() : null,
    userProfile,
    userLicense,
    onLogout,
    gate
  };

  // Sync is now handled by useDatabase hook (Electron) — no localStorage sync needed

  // ── RENDER ──
  const isPopoutElectron = isElectron && isPopoutMode;

  return (
    <div 
      className={`h-[100dvh] flex flex-col font-sans overflow-hidden transition-colors duration-300 ${
        isPopoutElectron ? '' : settings.theme === 'dark' ? 'dark bg-[#09090b]' : 'bg-slate-50'
      }`}
      style={isPopoutElectron ? { background: 'transparent' } : undefined}
    >
        {/* ── CONTENT AREA ── */}
        {isPopoutElectron ? (
            /* Electron pop-out: always show compact chat */
            <ChatInterface {...sharedProps} />
        ) : !isPipMode ? (
            /* Main window: full app */
            <ChatInterface {...sharedProps} />
        ) : (
            /* Main window when pop-out is active: safe placeholder */
            <div className="flex-1 flex flex-col items-center justify-center p-8 bg-surface/50 text-center space-y-6 animate-in fade-in">
                <div className="w-24 h-24 rounded-full bg-blue-500/10 flex items-center justify-center animate-pulse-slow">
                    <ExternalLink size={40} className="text-blue-500" />
                </div>
                <div>
                    <h2 className="text-2xl font-bold text-text mb-2">Copilot Active in Pop-out Window</h2>
                    <p className="text-gray-500 max-w-md mx-auto">
                        {isElectron 
                          ? <>The AI copilot is running in a transparent overlay.<br/>It is <strong className="text-green-400">invisible to screen share</strong>.</>
                          : <>This tab is now "Safe to Share".<br/>The AI interface has moved to a separate window that is hidden from screen share.</>
                        }
                    </p>
                </div>
                <div className="p-4 bg-surface rounded-lg border border-border text-left w-full max-w-lg shadow-sm">
                    <p className="text-xs text-gray-400 uppercase tracking-wider font-bold mb-2">Safe View Placeholder</p>
                    <div className="space-y-2 opacity-50">
                         <div className="h-4 bg-gray-500 rounded w-3/4"></div>
                         <div className="h-4 bg-gray-500 rounded w-1/2"></div>
                         <div className="h-4 bg-gray-500 rounded w-5/6"></div>
                    </div>
                </div>
                <button 
                    onClick={() => {
                      if (isElectron) {
                        electronIPC.send('close-popout');
                      }
                      setIsPipMode(false);
                    }}
                    className="px-6 py-3 bg-primary hover:bg-blue-600 text-white rounded-lg font-medium transition-colors flex items-center gap-2"
                >
                    <ExternalLink size={18} className="rotate-180" /> Bring Back to Tab
                </button>
            </div>
        )}

        {/* PiP Portal — only used in web browser, NOT in Electron */}
        {isPipMode && !isElectron && (
            <PiPWindow onClose={() => setIsPipMode(false)}>
                <ChatInterface {...sharedProps} />
            </PiPWindow>
        )}

      {/* --- MODALS --- */}
      
      <Modal isOpen={showSettings} onClose={() => setShowSettings(false)} title="Settings">
         <div className="space-y-6">
            
            {/* Model Selection */}
            <div className="bg-surface/50 border border-border p-3 rounded-lg space-y-3">
                <div className="flex items-center justify-between">
                    <label className="text-sm font-bold text-text flex items-center gap-2">
                        <Cpu size={16} /> AI Model Selection
                    </label>
                    {gate.isPro ? (
                      <span className="text-[10px] text-green-400 font-medium bg-green-400/10 px-2 py-0.5 rounded-full border border-green-400/20">
                        For better experience choose GPT-5.4 Mini
                      </span>
                    ) : (
                      <span className="text-[10px] text-amber-400 font-medium bg-amber-400/10 px-2 py-0.5 rounded-full border border-amber-400/20 flex items-center gap-1">
                        <Lock size={8} /> Upgrade to Pro for all models
                      </span>
                    )}
                </div>
                <div className="flex flex-wrap gap-2">
                    <button
                        onClick={() => setTempModel('gemini')}
                        className={`relative px-3 py-1.5 rounded-full border text-left transition-all hover:shadow-md flex items-center gap-2 ${
                            tempModel === 'gemini' 
                            ? 'bg-blue-500/10 border-blue-500 shadow-sm' 
                            : 'bg-background border-border hover:border-gray-400 opacity-60 hover:opacity-100'
                        }`}
                    >
                        <div className={`w-1.5 h-1.5 rounded-full ${tempModel === 'gemini' ? 'bg-blue-500' : 'bg-gray-400'}`}></div>
                        <span className={`font-bold text-xs ${tempModel === 'gemini' ? 'text-blue-500' : 'text-text'}`}>
                            Gemini 3.1 Flash
                        </span>
                    </button>

                    <button
                        onClick={() => gate.canUseModel('groq') && setTempModel('groq')}
                        disabled={!gate.canUseModel('groq')}
                        className={`relative px-3 py-1.5 rounded-full border text-left transition-all flex items-center gap-2 ${
                            !gate.canUseModel('groq')
                            ? 'bg-background border-border opacity-40 cursor-not-allowed'
                            : tempModel === 'groq'
                            ? 'bg-orange-500/10 border-orange-500 shadow-sm'
                            : 'bg-background border-border hover:border-gray-400 opacity-60 hover:opacity-100 hover:shadow-md'
                        }`}
                    >
                        <div className={`w-1.5 h-1.5 rounded-full ${tempModel === 'groq' ? 'bg-orange-500' : 'bg-gray-400'}`}></div>
                        <span className={`font-bold text-xs ${tempModel === 'groq' ? 'text-orange-500' : 'text-text'}`}>
                            Groq
                        </span>
                        {!gate.canUseModel('groq') && <Lock size={10} className="text-amber-400 ml-1" />}
                    </button>

                    <button
                        onClick={() => gate.canUseModel('openai') && setTempModel('openai')}
                        disabled={!gate.canUseModel('openai')}
                        className={`relative px-3 py-1.5 rounded-full border text-left transition-all flex items-center gap-2 ${
                            !gate.canUseModel('openai')
                            ? 'bg-background border-border opacity-40 cursor-not-allowed'
                            : tempModel === 'openai'
                            ? 'bg-green-500/10 border-green-500 shadow-sm'
                            : 'bg-background border-border hover:border-gray-400 opacity-60 hover:opacity-100 hover:shadow-md'
                        }`}
                    >
                        <div className={`w-1.5 h-1.5 rounded-full ${tempModel === 'openai' ? 'bg-green-500' : 'bg-gray-400'}`}></div>
                        <span className={`font-bold text-xs ${tempModel === 'openai' ? 'text-green-500' : 'text-text'}`}>
                            GPT-5.4 Mini {gate.canUseModel('openai') && <span className="ml-1 text-[9px] bg-green-500 text-white px-1.5 py-0.5 rounded-full">Recommended</span>}
                        </span>
                        {!gate.canUseModel('openai') && <Lock size={10} className="text-amber-400 ml-1" />}
                    </button>

                    <button
                        onClick={() => gate.canUseModel('xai') && setTempModel('xai')}
                        disabled={!gate.canUseModel('xai')}
                        className={`relative px-3 py-1.5 rounded-full border text-left transition-all flex items-center gap-2 ${
                            !gate.canUseModel('xai')
                            ? 'bg-background border-border opacity-40 cursor-not-allowed'
                            : tempModel === 'xai'
                            ? 'bg-gray-500/10 border-gray-500 shadow-sm'
                            : 'bg-background border-border hover:border-gray-400 opacity-60 hover:opacity-100 hover:shadow-md'
                        }`}
                    >
                        <div className={`w-1.5 h-1.5 rounded-full ${tempModel === 'xai' ? 'bg-white' : 'bg-gray-400'}`}></div>
                        <span className={`font-bold text-xs ${tempModel === 'xai' ? 'text-text' : 'text-text'}`}>
                            Grok (xAI)
                        </span>
                        {!gate.canUseModel('xai') && <Lock size={10} className="text-amber-400 ml-1" />}
                    </button>
                </div>
            </div>

            {/* AI is powered by server — no API keys needed */}
            <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-3">
                <div className="flex items-center gap-2 text-green-400 text-xs font-medium">
                    <Check size={14} /> AI models are managed by minicaai — no API keys needed
                </div>
            </div>

            <button
                onClick={saveSettings}
                className={`w-full px-4 py-2 rounded-lg font-medium text-sm flex items-center justify-center gap-2 transition-all ${
                    saveStatus === 'saved'
                    ? 'bg-green-500 text-white'
                    : 'bg-primary text-white hover:bg-blue-600'
                }`}
            >
                {saveStatus === 'saved' ? <Check size={16} /> : <Save size={16} />}
                {saveStatus === 'saved' ? 'Settings Saved' : 'Save Settings'}
            </button>

            <div className="border-t border-border pt-4 space-y-4">
                {/* Theme Toggle */}
                <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-text">App Theme</span>
                    <div className="flex items-center bg-background border border-border rounded-lg p-1">
                        <button 
                            onClick={() => setSettings(s => ({...s, theme: 'light'}))}
                            className={`p-2 rounded-md transition-all ${settings.theme === 'light' ? 'bg-white shadow text-black' : 'text-gray-400 hover:text-gray-200'}`}
                        >
                            <Sun size={16} />
                        </button>
                        <button 
                            onClick={() => setSettings(s => ({...s, theme: 'dark'}))}
                            className={`p-2 rounded-md transition-all ${settings.theme === 'dark' ? 'bg-gray-700 shadow text-white' : 'text-gray-400 hover:text-gray-600'}`}
                        >
                            <Moon size={16} />
                        </button>
                    </div>
                </div>

                {/* Font Size Toggle */}
                <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-text">Text Size</span>
                    <div className="flex items-center gap-2">
                        {(['small', 'medium', 'large'] as const).map((size) => (
                            <button
                                key={size}
                                onClick={() => setSettings(s => ({...s, fontSize: size}))}
                                className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-all ${
                                    settings.fontSize === size 
                                    ? 'bg-primary text-white border-primary' 
                                    : 'bg-transparent text-gray-500 border-border hover:border-gray-400'
                                }`}
                            >
                                {size.charAt(0).toUpperCase() + size.slice(1)}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

         </div>
      </Modal>

      {/* --- Context Files Modal --- */}
      <Modal isOpen={showContext} onClose={() => setShowContext(false)} title="Knowledge Base">
        <div className="space-y-6">
           {/* Info Banner */}
           <div className="bg-blue-500/10 border border-blue-500/20 rounded-lg p-3">
               <div className="flex items-start gap-3">
                   <Info size={18} className="text-blue-500 mt-0.5" />
                   <div className="text-xs text-blue-200/80 leading-relaxed">
                       <strong className="text-blue-400 block mb-1">How Context Works</strong>
                       Files uploaded here are sent to the AI with every message. 
                       Use "Context Mode" to force the AI to rely on these files.
                   </div>
               </div>
           </div>

           {/* File List */}
           <div className="space-y-3">
               <div className="flex items-center justify-between">
                   <h3 className="text-sm font-bold text-text">
                     Attached Files ({db.contextFiles.length}{gate.maxContextFiles !== -1 ? `/${gate.maxContextFiles}` : ''})
                   </h3>
                   <button onClick={triggerFileUpload} disabled={gate.maxContextFiles !== -1 && db.contextFiles.length >= gate.maxContextFiles} className={`text-xs flex items-center gap-1 ${gate.maxContextFiles !== -1 && db.contextFiles.length >= gate.maxContextFiles ? 'text-gray-500 cursor-not-allowed' : 'text-primary hover:underline'}`}>
                       <Plus size={12} /> {gate.maxContextFiles !== -1 && db.contextFiles.length >= gate.maxContextFiles ? 'Limit reached' : 'Add File'}
                   </button>
                   {/* HIDDEN INPUT */}
                   <input 
                       type="file" 
                       ref={fileInputRef} 
                       className="hidden"
                       onChange={handleFileUpload}
                       accept=".pdf,.txt,.md,.json,.js,.ts,.py,.html,.css,.csv,.png,.jpg,.jpeg"
                   />
               </div>
               
               <div className="space-y-2 max-h-[200px] overflow-y-auto custom-scrollbar pr-1">
                   {db.contextFiles.length === 0 && (
                       <div className="text-center py-6 border border-dashed border-border rounded-xl text-gray-500">
                           <FilePlus size={24} className="mx-auto mb-2 opacity-50" />
                           <p className="text-xs">No files added.</p>
                       </div>
                   )}
                   {db.contextFiles.map(file => (
                       <div key={file.id} className="flex items-center justify-between p-2.5 bg-background border border-border rounded-lg group hover:border-primary/30 transition-colors">
                           <div className="flex items-center gap-3 overflow-hidden">
                               <div className="w-8 h-8 rounded bg-gray-500/10 flex items-center justify-center shrink-0">
                                   <FileText size={14} className="text-gray-400" />
                               </div>
                               <div className="min-w-0">
                                   <p className="text-xs font-medium text-text truncate max-w-[180px]">{file.name}</p>
                                   <p className="text-[10px] text-gray-500 uppercase">{file.type}</p>
                               </div>
                           </div>
                           <button onClick={() => removeFile(file.id)} className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors opacity-0 group-hover:opacity-100">
                               <Trash2 size={14} />
                           </button>
                       </div>
                   ))}
               </div>
           </div>

           {/* Paste Text Section */}
           <div className="space-y-3 pt-4 border-t border-border">
               <h3 className="text-sm font-bold text-text">Quick Paste</h3>
               <div className="relative">
                   <textarea
                        value={pasteContent}
                        onChange={(e) => setPasteContent(e.target.value)}
                        placeholder="Paste Resume text, Job Description, or Notes here..."
                        className="w-full h-32 bg-background border border-border rounded-xl p-3 text-xs focus:ring-1 focus:ring-primary outline-none resize-none custom-scrollbar"
                   />
                   <div className="absolute bottom-2 right-2">
                       <button 
                            onClick={handleAddPasteText}
                            disabled={!pasteContent.trim()}
                            className={`p-2 rounded-lg transition-all ${pasteContent.trim() ? 'bg-primary text-white shadow-lg hover:bg-blue-600' : 'bg-surface text-gray-500 cursor-not-allowed border border-border'}`}
                            title="Add as Context"
                       >
                           <Plus size={16} />
                       </button>
                   </div>
               </div>
           </div>

           {/* General Mode Toggle within Context */}
           <div className="flex items-center justify-between pt-2">
               <div className="flex flex-col">
                   <span className="text-sm font-medium text-text">General Knowledge Mode</span>
                   <span className="text-[10px] text-gray-500">
                       {settings.generalMode ? "AI uses broad knowledge (Wikipedia-style)." : "AI relies strictly on your files."}
                   </span>
               </div>
               <button 
                   onClick={toggleGeneralMode}
                   className={`text-2xl transition-colors ${settings.generalMode ? 'text-green-500' : 'text-gray-500'}`}
               >
                   {settings.generalMode ? <ToggleRight size={32} /> : <ToggleLeft size={32} />}
               </button>
           </div>
        </div>
      </Modal>

      {/* --- Help Modal --- */}
      <Modal isOpen={showHelp} onClose={() => setShowHelp(false)} title="Audio Setup Help">
          <div className="space-y-4 text-sm text-text">
              <div className="p-4 bg-surface border border-border rounded-xl space-y-3">
                  <h3 className="font-bold flex items-center gap-2"><Mic size={16} className="text-red-500" /> How to Capture Audio</h3>
                  <ol className="list-decimal list-inside space-y-2 text-gray-400 ml-1">
                      <li>Click the <span className="text-text font-bold">MIC (OFF)</span> button in the bottom bar.</li>
                      <li>A browser popup will ask to share your screen.</li>
                      <li>Select the <span className="text-text font-bold">Chrome Tab</span> where your meeting is running (e.g., Google Meet, Zoom Web).</li>
                      <li><span className="text-red-400 font-bold underline decoration-wavy">CRITICAL:</span> Check the box <strong>"Also share tab audio"</strong> in the bottom left of the popup.</li>
                      <li>Click <strong>Share</strong>. The status will turn to <span className="text-red-500 font-bold">LIVE</span>.</li>
                  </ol>
              </div>
              <div className="p-4 bg-surface border border-border rounded-xl space-y-2">
                  <h3 className="font-bold flex items-center gap-2"><ExternalLink size={16} className="text-blue-500" /> Pop-out Mode</h3>
                  <p className="text-gray-400 leading-relaxed">
                      If you are sharing your <strong>Entire Screen</strong>, the interviewer will see this AI overlay. 
                      To hide it, click the <span className="text-blue-500 font-bold">Pop-out Icon</span> in the top right. 
                      This moves the AI to a separate window that is <em>not</em> visible in screen share.
                  </p>
              </div>
          </div>
      </Modal>

      {/* Download modal — web only, never shown in Electron */}
      {!isElectron && (
        <Modal isOpen={showDownloadModal} onClose={() => setShowDownloadModal(false)} title="Download Interview Copilot">
            <div className="space-y-6 text-center">
                <div className="w-16 h-16 bg-gradient-to-br from-blue-500/20 to-purple-600/20 rounded-2xl flex items-center justify-center mx-auto mb-4 border border-blue-500/30">
                    <Download size={32} className="text-blue-500" />
                </div>
                <h3 className="text-xl font-bold text-text">Experience Stealth Mode</h3>
                <p className="text-sm text-gray-400 max-w-sm mx-auto leading-relaxed">
                    The desktop app runs natively on your system and is <strong className="text-white">completely invisible to screen sharing apps</strong> like Zoom, Google Meet, and MS Teams.
                </p>

                <div className="grid grid-cols-1 gap-3 pt-4">
                    <a href="https://github.com/madhavvan/h2so4/releases/latest/download/InterviewCopilot-Setup.exe" target="_blank" rel="noopener noreferrer" className="flex items-center justify-between p-4 rounded-xl border border-border bg-surface hover:border-blue-500 hover:bg-blue-500/5 transition-all group">
                        <div className="flex items-center gap-4">
                            <div className="p-2 bg-blue-500/10 rounded-lg group-hover:bg-blue-500/20 transition-colors">
                                <Monitor size={24} className="text-blue-400 group-hover:text-blue-500" />
                            </div>
                            <div className="text-left">
                                <div className="font-bold text-text group-hover:text-blue-400 transition-colors">Download for Windows</div>
                                <div className="text-xs text-gray-500">Windows 10/11 (.exe)</div>
                            </div>
                        </div>
                        <Download size={18} className="text-gray-500 group-hover:text-blue-500 transition-colors" />
                    </a>

                    <a href="https://github.com/madhavvan/h2so4/releases/latest/download/InterviewCopilot-Mac.dmg" target="_blank" rel="noopener noreferrer" className="flex items-center justify-between p-4 rounded-xl border border-border bg-surface hover:border-purple-500 hover:bg-purple-500/5 transition-all group">
                        <div className="flex items-center gap-4">
                            <div className="p-2 bg-purple-500/10 rounded-lg group-hover:bg-purple-500/20 transition-colors">
                                <Laptop size={24} className="text-purple-400 group-hover:text-purple-500" />
                            </div>
                            <div className="text-left">
                                <div className="font-bold text-text group-hover:text-purple-400 transition-colors">Download for Mac</div>
                                <div className="text-xs text-gray-500">macOS 10.15+ (.dmg)</div>
                            </div>
                        </div>
                        <Download size={18} className="text-gray-500 group-hover:text-purple-500 transition-colors" />
                    </a>

                    <a href="https://github.com/madhavvan/h2so4/releases/latest/download/InterviewCopilot-Linux.AppImage" target="_blank" rel="noopener noreferrer" className="flex items-center justify-between p-4 rounded-xl border border-border bg-surface hover:border-orange-500 hover:bg-orange-500/5 transition-all group">
                        <div className="flex items-center gap-4">
                            <div className="p-2 bg-orange-500/10 rounded-lg group-hover:bg-orange-500/20 transition-colors">
                                <Terminal size={24} className="text-orange-400 group-hover:text-orange-500" />
                            </div>
                            <div className="text-left">
                                <div className="font-bold text-text group-hover:text-orange-400 transition-colors">Download for Linux</div>
                                <div className="text-xs text-gray-500">Any distro (.AppImage)</div>
                            </div>
                        </div>
                        <Download size={18} className="text-gray-500 group-hover:text-orange-500 transition-colors" />
                    </a>
                </div>
            </div>
        </Modal>
      )}

    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  APP WRAPPER — Subscription gate + feature enforcement
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export default function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [license, setLicense] = useState<LicenseData | null>(null);

  useEffect(() => {
    const saved = licenseService.loadAuth();
    if (saved.user && saved.license && licenseService.isLicenseValid(saved.license)) {
      setUser(saved.user);
      setLicense(saved.license);
      setAuthenticated(true);
      licenseService.startRevalidation();
    }
    return () => licenseService.stopRevalidation();
  }, []);

  // Revalidate license when app regains focus (e.g. after paying in browser)
  useEffect(() => {
    const handleFocus = async () => {
      const saved = licenseService.loadAuth();
      if (saved.user && saved.token) {
        const updated = await licenseService.validateWithServer();
        if (updated) {
          const refreshedUser = { ...saved.user, tier: updated.tier };
          setUser(refreshedUser);
          setLicense(updated);
          licenseService.saveAuth(refreshedUser, updated, saved.token);
          if (!authenticated && licenseService.isLicenseValid(updated)) {
            setAuthenticated(true);
          }
        }
      }
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [authenticated]);

  const handleLogout = () => {
    licenseService.logout();
    setAuthenticated(false);
    setUser(null);
    setLicense(null);
  };

  if (!authenticated) {
    return (
      <SubscriptionGate
        onAuthenticated={(u, l) => {
          setUser(u);
          setLicense(l);
          setAuthenticated(true);
          licenseService.startRevalidation();
        }}
      />
    );
  }

  // Web is not an official surface — authenticated web users see the download page
  // inside SubscriptionGate, not MainApp. The app itself is Electron-only.
  if (!isElectron && !isPopoutMode) {
    return (
      <SubscriptionGate
        onAuthenticated={(u, l) => {
          setUser(u);
          setLicense(l);
          setAuthenticated(true);
        }}
      />
    );
  }

  return <MainApp userProfile={user} userLicense={license} onLogout={handleLogout} />;
}