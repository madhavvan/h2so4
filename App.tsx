import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Settings, Mic, MicOff, Send, FileText, Upload, Trash2, Cpu, FileCheck, RefreshCw, HelpCircle, AlertTriangle, Zap, MessageSquare, Edit3, X, ChevronDown, Menu, ExternalLink, Eye, EyeOff, Moon, Sun, Copy, Check, Save, ToggleLeft, ToggleRight, Info, ScreenShare, ScreenShareOff, Plus, FilePlus } from 'lucide-react';
import { geminiService } from './services/geminiService';
import { groqService } from './services/groqService';
import { useSpeechRecognition } from './hooks/useSpeechRecognition';
import { Message, AppSettings, ContextFile } from './types';

// Extend Window interface for PiP support
declare global {
  interface Window {
    documentPictureInPicture: any;
  }
}

// --- Helper: Code Block Renderer ---

const CodeBlock = ({ code, language }: { code: string, language: string }) => {
    const [copied, setCopied] = useState(false);

    const handleCopy = () => {
        navigator.clipboard.writeText(code);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="my-3 rounded-lg overflow-hidden border border-gray-700 bg-[#1e1e1e] shadow-lg">
            <div className="flex items-center justify-between px-4 py-2 bg-[#2d2d2d] border-b border-gray-700">
                <span className="text-xs font-mono text-gray-400 lowercase">{language || 'code'}</span>
                <button 
                    onClick={handleCopy} 
                    className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white transition-colors"
                >
                    {copied ? <Check size={12} className="text-green-400"/> : <Copy size={12} />}
                    {copied ? "Copied" : "Copy"}
                </button>
            </div>
            <div className="p-4 overflow-x-auto">
                <pre className="font-mono text-sm leading-relaxed text-gray-300">
                    <code>{code.trim()}</code>
                </pre>
            </div>
        </div>
    );
};

const MessageRenderer = ({ content, fontSize }: { content: string, fontSize: string }) => {
    // Regex to split by code blocks: ```language ... ```
    // Capturing groups: 1=lang, 2=code
    const parts = content.split(/```(\w*)\n([\s\S]*?)```/g);

    // Font size mapping
    const sizeClass = 
        fontSize === 'small' ? 'text-xs md:text-sm' : 
        fontSize === 'large' ? 'text-base md:text-lg' : 
        'text-sm md:text-base';

    return (
        <div className={`whitespace-pre-wrap leading-relaxed ${sizeClass}`}>
            {parts.map((part, index) => {
                if (index % 3 === 2) {
                    // This is the code part (group 2)
                    const lang = parts[index - 1]; // group 1
                    return <CodeBlock key={index} code={part} language={lang} />;
                } else if (index % 3 === 0) {
                    // This is text part
                    if (!part.trim()) return null;
                    return <span key={index}>{part}</span>;
                }
                return null;
            })}
        </div>
    );
};

// --- Components ---

const Modal = ({ isOpen, onClose, title, children }: any) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-in fade-in duration-200">
      <div className="bg-surface border border-border rounded-xl w-full max-w-lg max-h-[85vh] flex flex-col shadow-2xl overflow-hidden text-text">
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
    handleClear, 
    handleRegenerate,
    chatContainerRef,
    textareaRef,
    handleScroll,
    onOpenSettings,
    onOpenContext,
    onOpenHelp,
    isPipMode,
    togglePip
}: any) => {
    return (
        <div className={`flex-1 flex flex-col h-full overflow-hidden relative bg-background text-text transition-colors duration-300 ${settings.theme === 'dark' ? 'dark' : ''}`}>
             {/* --- RESPONSIVE HEADER --- */}
            <header className="h-14 md:h-16 border-b border-border bg-surface/80 backdrop-blur-md flex items-center justify-between px-4 shrink-0 z-20 sticky top-0">
                <div className="flex items-center gap-2 md:gap-3">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
                    <Cpu size={18} className="text-white" />
                </div>
                <h1 className="font-bold text-base md:text-lg tracking-tight hidden xs:block">Interview<span className="text-blue-500">Copilot</span></h1>
                </div>

                <div className="flex items-center gap-2 md:gap-3">
                    <div className={`hidden md:flex px-3 py-1 rounded-full text-xs font-medium items-center gap-2 border transition-all duration-300 ${isListening ? 'bg-red-500/10 border-red-500/50 text-red-500' : 'bg-surface border-border text-gray-500'}`}>
                        <div className={`w-2 h-2 rounded-full ${isListening ? 'bg-red-500 animate-pulse' : 'bg-gray-500'}`}></div>
                        {isListening ? 'LIVE' : 'OFF'}
                    </div>
                    
                    {!isPipMode && (
                        <button 
                            onClick={togglePip} 
                            className="p-2 text-primary hover:bg-blue-500/10 rounded-lg transition-all border border-blue-500/20" 
                            title="Pop Out (Hide from Screen Share)"
                        >
                            <ExternalLink size={20} />
                        </button>
                    )}

                    <button onClick={onOpenHelp} className="p-2 text-gray-400 hover:text-text hover:bg-surface border border-transparent hover:border-border rounded-lg transition-all" title="Audio Help"><HelpCircle size={20} /></button>
                    <button onClick={onOpenContext} className="p-2 text-gray-400 hover:text-text hover:bg-surface border border-transparent hover:border-border rounded-lg transition-all" title="Files"><FileText size={20} /></button>
                    <button onClick={onOpenSettings} className={`p-2 rounded-lg transition-all border border-transparent hover:border-border ${!settings.apiKey ? 'text-red-400 animate-pulse' : 'text-gray-400 hover:text-text hover:bg-surface'}`} title="Settings"><Settings size={20} /></button>
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
                            ? 'bg-surface text-text border border-border rounded-tr-sm' 
                            : msg.role === 'system'
                            ? 'bg-red-500/10 border border-red-500/50 text-red-500'
                            : 'bg-primary/5 border border-primary/20 text-text rounded-tl-sm backdrop-blur-sm'
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
                        <div className="bg-surface border border-border rounded-2xl px-4 py-3 rounded-tl-sm flex items-center gap-2 text-gray-500 text-xs shadow-lg">
                            <span className="font-semibold text-primary tracking-wider">THINKING ({settings.selectedModel === 'groq' ? 'GROQ' : 'GEMINI'})</span>
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
                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-background via-background to-transparent pt-4 pb-4 px-2 md:px-6 z-20">
                    <div className="max-w-3xl mx-auto flex flex-col gap-2">
                        
                        {speechError && (
                            <div className="mx-auto bg-red-500/90 text-white px-3 py-1 rounded-full text-xs border border-red-400 flex items-center gap-2 shadow-lg backdrop-blur">
                                <AlertTriangle size={10} /> {speechError}
                            </div>
                        )}

                        <div className={`bg-surface/90 backdrop-blur-xl border rounded-2xl shadow-2xl transition-all duration-300 flex flex-col ${isListening ? 'border-primary/50 shadow-[0_0_20px_rgba(59,130,246,0.15)]' : 'border-border'}`}>
                            
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
            </main>
        </div>
    );
};

// PiP Window Logic
const PiPWindow = ({ children, onClose }: { children: React.ReactNode, onClose: () => void }) => {
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
                 :root { --bg-color: #f8fafc; --surface-color: #ffffff; --border-color: #e2e8f0; --text-color: #0f172a; }
                 .dark { --bg-color: #09090b; --surface-color: #18181b; --border-color: #27272a; --text-color: #e4e4e7; }
                  ::-webkit-scrollbar { width: 8px; }
                  ::-webkit-scrollbar-track { background: var(--surface-color); }
                  ::-webkit-scrollbar-thumb { background: var(--border-color); border-radius: 4px; }
                  body { background-color: var(--bg-color); color: var(--text-color); margin: 0; font-family: ui-sans-serif, system-ui; }
                `;
                pipWindow.document.head.appendChild(style);


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


export default function App() {
  // --- State ---
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState("");
  const [interimText, setInterimText] = useState("");
  
  const [isProcessing, setIsProcessing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  
  // Local state for Quick Paste in Context Modal
  const [pasteContent, setPasteContent] = useState("");
  
  // PiP State
  const [isPipMode, setIsPipMode] = useState(false);

  // Settings State
  const [settings, setSettings] = useState<AppSettings>({
    apiKey: localStorage.getItem("GEMINI_API_KEY") || "",
    deepgramApiKey: localStorage.getItem("DEEPGRAM_API_KEY") || "",
    groqApiKey: localStorage.getItem("GROQ_API_KEY") || "",
    selectedModel: (localStorage.getItem("SELECTED_MODEL") as 'gemini'|'groq') || 'gemini',
    autoSend: false, 
    // Start with empty array - no placeholders
    contextFiles: [],
    theme: (localStorage.getItem("THEME") as 'light'|'dark') || 'dark',
    fontSize: (localStorage.getItem("FONT_SIZE") as 'small'|'medium'|'large') || 'medium',
    generalMode: localStorage.getItem("GENERAL_MODE") === 'true' // Default false (Context Mode)
  });

  // Settings Modal Local State
  const [tempApiKey, setTempApiKey] = useState("");
  const [tempDeepgramKey, setTempDeepgramKey] = useState("");
  const [tempGroqKey, setTempGroqKey] = useState("");
  const [tempModel, setTempModel] = useState<'gemini'|'groq'>('gemini');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved'>('idle');

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

  // Sync temp key when settings open
  useEffect(() => {
      if (showSettings) {
          setTempApiKey(settings.apiKey);
          setTempDeepgramKey(settings.deepgramApiKey);
          setTempGroqKey(settings.groqApiKey);
          setTempModel(settings.selectedModel);
          setSaveStatus('idle');
      }
  }, [showSettings, settings.apiKey, settings.deepgramApiKey, settings.groqApiKey, settings.selectedModel]);


  // Scroll State
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);

  // Ref pattern to fix closure staleness in callbacks
  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

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

  // --- Initialization ---
  useEffect(() => {
    if (settings.apiKey) {
      geminiService.init(settings.apiKey);
    }
    if (settings.groqApiKey) {
      groqService.init(settings.groqApiKey);
    }
  }, [settings.apiKey, settings.groqApiKey]);

  // Handle Auto-Scrolling
  useEffect(() => {
    if (shouldAutoScroll && chatContainerRef.current) {
      chatContainerRef.current.scrollTo({
          top: chatContainerRef.current.scrollHeight,
          behavior: 'smooth'
      });
    }
  }, [messages, interimText, shouldAutoScroll]);

  const handleScroll = () => {
      if (!chatContainerRef.current) return;
      const { scrollTop, scrollHeight, clientHeight } = chatContainerRef.current;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
      setShouldAutoScroll(isAtBottom);
  };

  // --- Core Logic ---
  const executeSend = useCallback(async (textToSend: string) => {
      if (!textToSend.trim()) return;
      
      const userMsg: Message = {
        id: Date.now().toString(),
        role: 'user',
        content: textToSend,
        timestamp: Date.now()
      };
  
      setMessages(prev => [...prev, userMsg]);
      setIsProcessing(true);
      setInterimText("");
      setInputText(""); 
      setShouldAutoScroll(true); 
  
      try {
        const currentSettings = settingsRef.current;
        let responseText = "";

        // Route request based on selected model
        if (currentSettings.selectedModel === 'groq') {
             responseText = await groqService.generateResponse(
                userMsg.content,
                messages,
                currentSettings.contextFiles,
                currentSettings.generalMode
             );
        } else {
             // Default to Gemini
             responseText = await geminiService.generateResponse(
                userMsg.content,
                messages, 
                currentSettings.contextFiles,
                currentSettings.generalMode
             );
        }
        
        if (responseText !== "Listening...") {
            const aiMsg: Message = {
              id: (Date.now() + 1).toString(),
              role: 'model',
              content: responseText,
              timestamp: Date.now()
            };
            setMessages(prev => [...prev, aiMsg]);
        }
      } catch (err) {
        console.error(err);
        const errorMsg: Message = {
          id: Date.now().toString(),
          role: 'system',
          content: "Error generating response. Check API Key.",
          timestamp: Date.now()
        };
        setMessages(prev => [...prev, errorMsg]);
      } finally {
        setIsProcessing(false);
      }
  }, [messages]); 

  // --- Speech Handling ---
  const handleSpeechResult = useCallback(({ final, interim }: { final: string, interim: string }) => {
    setInterimText(interim);
    if (interim && silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
    }
    if (final) {
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

  const { isListening, error: speechError, startListening, stopListening } = useSpeechRecognition({
    onResult: handleSpeechResult,
    onError: (err) => console.error("Speech Error:", err),
    apiKey: settings.deepgramApiKey // Pass Deepgram Key
  });

  // Auto-start listening if autoSend is on is slightly dangerous with Screen Share 
  // because it prompts every time. Disabling auto-start for System Audio.
  // We only start if the user clicks the button.

  // --- UI Actions ---
  const handleManualSend = () => {
    if (!inputText.trim() || isProcessing) return;
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    executeSend(inputText);
  };

  const handleClear = () => {
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
        let responseText = "";

        if (currentSettings.selectedModel === 'groq') {
            responseText = await groqService.generateResponse(
                lastUserMsg.content,
                historyForService,
                currentSettings.contextFiles,
                currentSettings.generalMode
            );
        } else {
            responseText = await geminiService.generateResponse(
                lastUserMsg.content,
                historyForService,
                currentSettings.contextFiles,
                currentSettings.generalMode
            );
        }

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

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
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
      setSettings(prev => ({ ...prev, contextFiles: [...prev.contextFiles, newFile] }));
    };
    reader.readAsDataURL(file);
  };
  
  const handleAddPasteText = () => {
      if (!pasteContent.trim()) return;
      const newFile: ContextFile = {
          id: Date.now().toString(),
          name: `Pasted Context ${settings.contextFiles.length + 1}`,
          content: pasteContent,
          type: 'custom'
      };
      setSettings(prev => ({ ...prev, contextFiles: [...prev.contextFiles, newFile] }));
      setPasteContent("");
  };

  const removeFile = (id: string) => {
    setSettings(prev => ({ ...prev, contextFiles: prev.contextFiles.filter(f => f.id !== id) }));
  };

  const toggleAutoSend = () => {
    setSettings(prev => ({ ...prev, autoSend: !prev.autoSend }));
  };
  
  const toggleGeneralMode = () => {
      setSettings(prev => ({ ...prev, generalMode: !prev.generalMode }));
  };

  const saveSettings = () => {
      localStorage.setItem("GEMINI_API_KEY", tempApiKey);
      localStorage.setItem("DEEPGRAM_API_KEY", tempDeepgramKey);
      localStorage.setItem("GROQ_API_KEY", tempGroqKey);
      localStorage.setItem("SELECTED_MODEL", tempModel);
      localStorage.setItem("THEME", settings.theme);
      localStorage.setItem("FONT_SIZE", settings.fontSize);
      
      setSettings(prev => ({ 
          ...prev, 
          apiKey: tempApiKey, 
          deepgramApiKey: tempDeepgramKey,
          groqApiKey: tempGroqKey,
          selectedModel: tempModel
      }));
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
  };

  // --- RENDER HELPERS ---

  const sharedProps = {
    messages, settings, isListening, isProcessing, inputText, setInputText, interimText,
    speechError, toggleAutoSend, startListening, stopListening, handleManualSend,
    handleClear, handleRegenerate, chatContainerRef, textareaRef, handleScroll,
    onOpenSettings: () => setShowSettings(true),
    onOpenContext: () => setShowContext(true),
    onOpenHelp: () => setShowHelp(true),
    isPipMode,
    togglePip: () => setIsPipMode(true)
  };

  return (
    <div className={`h-[100dvh] flex flex-col font-sans overflow-hidden transition-colors duration-300 ${settings.theme === 'dark' ? 'dark bg-[#09090b]' : 'bg-slate-50'}`}>
        {/* Main Content Area */}
        {!isPipMode ? (
            <ChatInterface {...sharedProps} />
        ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-8 bg-surface/50 text-center space-y-6 animate-in fade-in">
                <div className="w-24 h-24 rounded-full bg-blue-500/10 flex items-center justify-center animate-pulse-slow">
                    <ExternalLink size={40} className="text-blue-500" />
                </div>
                <div>
                    <h2 className="text-2xl font-bold text-text mb-2">Copilot Active in Pop-out Window</h2>
                    <p className="text-gray-500 max-w-md mx-auto">
                        This tab is now "Safe to Share".<br/>
                        The AI interface has moved to a separate window that is hidden from screen share.
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
                    onClick={() => setIsPipMode(false)}
                    className="px-6 py-3 bg-primary hover:bg-blue-600 text-white rounded-lg font-medium transition-colors flex items-center gap-2"
                >
                    <ExternalLink size={18} className="rotate-180" /> Bring Back to Tab
                </button>
            </div>
        )}

        {/* PiP Portal */}
        {isPipMode && (
            <PiPWindow onClose={() => setIsPipMode(false)}>
                <ChatInterface {...sharedProps} />
            </PiPWindow>
        )}

      {/* --- MODALS --- */}
      
      <Modal isOpen={showSettings} onClose={() => setShowSettings(false)} title="Settings">
         <div className="space-y-6">
            
            {/* Model Selection */}
            <div className="bg-surface/50 border border-border p-3 rounded-lg space-y-3">
                <label className="text-sm font-bold text-text flex items-center gap-2">
                    <Cpu size={16} /> AI Model Selection
                </label>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <button
                        onClick={() => setTempModel('gemini')}
                        className={`relative p-3 rounded-xl border text-left transition-all hover:shadow-md flex flex-col gap-2 h-full ${
                            tempModel === 'gemini' 
                            ? 'bg-blue-500/10 border-blue-500 shadow-sm' 
                            : 'bg-background border-border hover:border-gray-400 opacity-60 hover:opacity-100'
                        }`}
                    >
                        <div className="flex items-center justify-between w-full">
                            <span className={`font-bold text-sm flex items-center gap-2 ${tempModel === 'gemini' ? 'text-blue-500' : 'text-text'}`}>
                                <div className={`w-2 h-2 rounded-full ${tempModel === 'gemini' ? 'bg-blue-500' : 'bg-gray-400'}`}></div>
                                Gemini 3 Flash
                            </span>
                            {tempModel === 'gemini' && <Check size={16} className="text-blue-500" />}
                        </div>
                        <p className="text-[11px] text-gray-500 leading-relaxed">
                            Best for <strong>Multimodal</strong> tasks (PDFs, Images) and long context windows. Reliable all-rounder.
                        </p>
                    </button>

                    <button
                        onClick={() => setTempModel('groq')}
                        className={`relative p-3 rounded-xl border text-left transition-all hover:shadow-md flex flex-col gap-2 h-full ${
                            tempModel === 'groq' 
                            ? 'bg-orange-500/10 border-orange-500 shadow-sm' 
                            : 'bg-background border-border hover:border-gray-400 opacity-60 hover:opacity-100'
                        }`}
                    >
                        <div className="flex items-center justify-between w-full">
                            <span className={`font-bold text-sm flex items-center gap-2 ${tempModel === 'groq' ? 'text-orange-500' : 'text-text'}`}>
                                <div className={`w-2 h-2 rounded-full ${tempModel === 'groq' ? 'bg-orange-500' : 'bg-gray-400'}`}></div>
                                Groq (Llama 4)
                            </span>
                            {tempModel === 'groq' && <Check size={16} className="text-orange-500" />}
                        </div>
                        <p className="text-[11px] text-gray-500 leading-relaxed">
                            Best for <strong>Extreme Speed</strong> & Reasoning. Supports Text & Images (No PDFs).
                        </p>
                    </button>
                </div>
            </div>

            {/* API Key Section */}
            <div className="space-y-4">
                <div className="space-y-1">
                    <div className="flex items-center justify-between">
                        <label className="text-sm font-medium text-text">Gemini API Key {tempModel === 'gemini' && <span className="text-red-500">*</span>}</label>
                        <a href="https://ai.google.dev/gemini-api/docs/api-key" target="_blank" rel="noreferrer" title="Create your own api key by signing up" className="text-xs text-primary hover:underline flex items-center gap-1">
                             Get Gemini API Key <ExternalLink size={10} />
                        </a>
                    </div>
                    <input 
                        type="password"
                        value={tempApiKey}
                        onChange={(e) => setTempApiKey(e.target.value)}
                        placeholder="Enter Gemini API Key"
                        className={`w-full bg-background border rounded-lg px-4 py-2.5 text-text focus:ring-1 focus:ring-primary outline-none text-sm ${tempModel === 'gemini' && !tempApiKey ? 'border-red-500/50' : 'border-border'}`}
                    />
                </div>

                <div className="space-y-1">
                    <div className="flex items-center justify-between">
                        <label className="text-sm font-medium text-text">Groq API Key {tempModel === 'groq' && <span className="text-red-500">*</span>}</label>
                        <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer" title="Create your own api key by signing up" className="text-xs text-primary hover:underline flex items-center gap-1">
                             Get Groq API Key <ExternalLink size={10} />
                        </a>
                    </div>
                    <input 
                        type="password"
                        value={tempGroqKey}
                        onChange={(e) => setTempGroqKey(e.target.value)}
                        placeholder="Enter Groq API Key (gsk_...)"
                        className={`w-full bg-background border rounded-lg px-4 py-2.5 text-text focus:ring-1 focus:ring-primary outline-none text-sm ${tempModel === 'groq' && !tempGroqKey ? 'border-red-500/50' : 'border-border'}`}
                    />
                </div>
                
                <div className="space-y-1 pt-2 border-t border-border">
                    <div className="flex items-center justify-between">
                        <label className="text-sm font-medium text-text">Deepgram API Key (System Audio)</label>
                        <a href="https://console.deepgram.com/signup" target="_blank" rel="noreferrer" title="Create your own api key by signing up" className="text-xs text-primary hover:underline flex items-center gap-1">
                             Get Deepgram API Key <ExternalLink size={10} />
                        </a>
                    </div>
                    <input 
                        type="password"
                        value={tempDeepgramKey}
                        onChange={(e) => setTempDeepgramKey(e.target.value)}
                        placeholder="Enter Deepgram API Key"
                        className="w-full bg-background border border-border rounded-lg px-4 py-2.5 text-text focus:ring-1 focus:ring-primary outline-none text-sm"
                    />
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
            </div>

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

      <Modal isOpen={showHelp} onClose={() => setShowHelp(false)} title="Audio Setup Guide">
         <div className="space-y-4 text-text text-sm">
            <div className="p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg">
                <p className="font-semibold text-blue-500">Goal: Transcribe Meeting Audio directly.</p>
                <p className="opacity-80">We use Screen Share to capture high-quality system audio without using your mic.</p>
            </div>
            
            <div className="space-y-2">
                <h4 className="font-medium">Instructions:</h4>
                <ol className="list-decimal pl-5 space-y-2 text-gray-500">
                    <li>Click the <strong>Mic/ON</strong> button in this app.</li>
                    <li>A browser popup will ask you to share your screen.</li>
                    <li>Select the <strong>Tab</strong> or <strong>Entire Screen</strong> where your meeting is happening.</li>
                    <li><strong className="text-red-400">CRITICAL:</strong> Check the box that says <strong>"Share tab audio"</strong> or <strong>"Share system audio"</strong> at the bottom left of the popup.</li>
                    <li>Click Share. The app will now listen to the meeting audio.</li>
                </ol>
            </div>

            <div className="p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg text-yellow-500 text-xs">
                Note: This requires a Deepgram API Key (set in Settings) as it provides much higher accuracy for system audio than browser default transcription.
            </div>
         </div>
      </Modal>

      <Modal isOpen={showContext} onClose={() => setShowContext(false)} title="Knowledge Base">
         <div className="space-y-4">
            {/* Description Block */}
            <div className="p-4 bg-blue-500/5 border border-blue-500/10 rounded-lg space-y-2">
                <div className="flex items-start gap-2">
                    <Info size={16} className="text-primary mt-0.5 shrink-0" />
                    <div>
                         <h3 className="text-sm font-semibold text-text">How Context Works</h3>
                         <p className="text-xs text-gray-500 leading-relaxed mt-1">
                             Upload your Resume and Job Description (JD). 
                             Groq supports <strong>Text</strong> and <strong>Images</strong>. Gemini supports PDFs.
                         </p>
                    </div>
                </div>
            </div>

            {/* Smart Mode Toggle */}
             <div className="flex items-center justify-between bg-surface border border-border p-3 rounded-lg">
                 <div>
                     <p className="text-sm font-medium text-text">Smart General Mode</p>
                     <p className="text-xs text-gray-500 mt-0.5">
                         {settings.generalMode 
                             ? "On: Answers are generic, unless asked about Resume." 
                             : "Off: Answers strictly grounded in uploaded files."}
                     </p>
                 </div>
                 <button 
                     onClick={toggleGeneralMode}
                     className={`text-2xl transition-colors ${settings.generalMode ? 'text-primary' : 'text-gray-600'}`}
                 >
                     {settings.generalMode ? <ToggleRight size={32} /> : <ToggleLeft size={32} />}
                 </button>
             </div>

            {/* NEW: Paste Text Area */}
            <div className="bg-background p-3 rounded-lg border border-border space-y-2">
                <p className="text-sm font-medium text-text flex items-center gap-2">
                    <Edit3 size={14} /> Quick Paste Context
                </p>
                <textarea 
                    value={pasteContent}
                    onChange={(e) => setPasteContent(e.target.value)}
                    placeholder="Paste Resume or JD text here for Groq/Gemini..."
                    className="w-full bg-surface border border-border rounded-lg p-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-primary h-24 max-h-48 custom-scrollbar resize-y"
                />
                <button 
                    onClick={handleAddPasteText}
                    disabled={!pasteContent.trim()}
                    className={`w-full py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-all border ${
                        pasteContent.trim() 
                        ? 'bg-primary/10 text-primary border-primary/30 hover:bg-primary/20' 
                        : 'bg-gray-500/5 text-gray-500 border-transparent cursor-not-allowed'
                    }`}
                >
                    Add as Text Context
                </button>
            </div>

            {/* Upload Area */}
            <div className="flex justify-between items-center bg-background p-3 rounded-lg border border-border mt-2">
                <div>
                    <p className="text-sm font-medium text-text">Upload Documents</p>
                    <p className="text-xs text-gray-500">PDF, Images, or Text files</p>
                </div>
                <label className="cursor-pointer bg-primary hover:bg-blue-600 text-white px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2">
                    <Upload size={14} /> Upload
                    <input type="file" accept="*/*" className="hidden" onChange={handleFileUpload} />
                </label>
            </div>

            {/* File List */}
            <div className="space-y-2 max-h-[40vh] overflow-y-auto pr-1 custom-scrollbar">
                {settings.contextFiles.map((file) => (
                    <div key={file.id} className="bg-surface border border-border rounded-lg p-3 flex items-center justify-between group">
                        <div className="flex items-center gap-3 overflow-hidden">
                            <div className={`p-2 rounded-lg shrink-0 ${file.type === 'resume' ? 'bg-purple-500/10 text-purple-500' : file.type === 'jd' ? 'bg-yellow-500/10 text-yellow-500' : 'bg-gray-500/10 text-gray-500'}`}>
                                {file.type === 'resume' ? <FileCheck size={18} /> : <FileText size={18} />}
                            </div>
                            <div className="min-w-0">
                                <h4 className="font-medium text-sm text-text truncate">{file.name}</h4>
                                <p className="text-[10px] text-gray-500 uppercase tracking-wider">{file.mimeType ? file.mimeType.split('/')[1].toUpperCase() : 'TEXT'}</p>
                            </div>
                        </div>
                        <button onClick={() => removeFile(file.id)} className="text-gray-400 hover:text-red-500 p-2 rounded hover:bg-background transition-colors">
                            <Trash2 size={16} />
                        </button>
                    </div>
                ))}
                {settings.contextFiles.length === 0 && (
                    <div className="text-center py-8 text-gray-500 text-sm border-2 border-dashed border-border rounded-xl">
                        No files uploaded.
                    </div>
                )}
            </div>
         </div>
      </Modal>

    </div>
  );
}