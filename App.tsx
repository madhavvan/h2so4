import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Settings, Mic, MicOff, Send, FileText, Upload, Trash2, Cpu, FileCheck, RefreshCw, HelpCircle, AlertTriangle, Zap, MessageSquare, Edit3, X, ChevronDown, Menu } from 'lucide-react';
import { geminiService } from './services/geminiService';
import { useSpeechRecognition } from './hooks/useSpeechRecognition';
import { INITIAL_JD_TEXT, INITIAL_RESUME_TEXT } from './constants';
import { Message, AppSettings, ContextFile } from './types';

// --- Components ---

const Modal = ({ isOpen, onClose, title, children }: any) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 bg-black/90 backdrop-blur-sm flex items-center justify-center z-50 p-4 animate-in fade-in duration-200">
      <div className="bg-surface border border-gray-700 rounded-xl w-full max-w-lg max-h-[85vh] flex flex-col shadow-2xl overflow-hidden">
        <div className="p-4 border-b border-gray-700 flex justify-between items-center bg-gray-900/50">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors p-1 rounded-full hover:bg-gray-800">
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

export default function App() {
  // --- State ---
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState("");
  const [interimText, setInterimText] = useState("");
  
  const [isProcessing, setIsProcessing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  
  const [settings, setSettings] = useState<AppSettings>({
    apiKey: localStorage.getItem("GEMINI_API_KEY") || "",
    autoSend: false, 
    contextFiles: [
      { id: '1', name: 'Placeholder Resume', content: INITIAL_RESUME_TEXT, type: 'resume' },
      { id: '2', name: 'Placeholder JD', content: INITIAL_JD_TEXT, type: 'jd' }
    ]
  });

  // Ref pattern to fix closure staleness in callbacks
  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  const chatContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const silenceTimerRef = useRef<any>(null);
  const inputTextRef = useRef(inputText);

  useEffect(() => {
    inputTextRef.current = inputText;
    // Auto-resize textarea
    if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        const height = Math.min(textareaRef.current.scrollHeight, 120); 
        textareaRef.current.style.height = height + 'px';
    }
  }, [inputText]);

  // --- Initialization ---
  useEffect(() => {
    if (settings.apiKey) {
      geminiService.init(settings.apiKey);
    }
  }, [settings.apiKey]);

  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [messages, interimText]);

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
  
      try {
        // Use ref to get latest settings even if function isn't recreated
        const currentSettings = settingsRef.current;
        const responseText = await geminiService.generateResponse(
          userMsg.content,
          messages, 
          currentSettings.contextFiles
        );
        
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
  }, [messages]); // Dependencies simplified due to refs

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

        // Use Ref for current auto-send state to avoid stale closure
        if (settingsRef.current.autoSend) {
            if (silenceTimerRef.current) {
                clearTimeout(silenceTimerRef.current);
            }
            silenceTimerRef.current = setTimeout(() => {
                const currentBuffer = inputTextRef.current;
                if (currentBuffer && currentBuffer.trim().length > 0) {
                     executeSend(currentBuffer);
                }
            }, 1200); 
        }
    }
  }, [executeSend]); // Dependencies stable

  const { isListening, error: speechError, startListening, stopListening } = useSpeechRecognition({
    onResult: handleSpeechResult,
    onError: (err) => console.error("Speech Error:", err)
  });

  // Auto-start listener when auto-send is enabled
  useEffect(() => {
      if (settings.autoSend && !isListening) {
          startListening();
      }
  }, [settings.autoSend, isListening, startListening]);

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
    // Optimistic UI update or just wait? Let's just wait.
    try {
        const historyForService = messages.filter(m => m.id !== lastUserMsg.id && m.role !== 'system');
        const responseText = await geminiService.generateResponse(
            lastUserMsg.content,
            historyForService,
            settingsRef.current.contextFiles
        );
        
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
      const content = event.target?.result as string;
      const newFile: ContextFile = {
        id: Date.now().toString(),
        name: file.name,
        content: content,
        type: 'custom'
      };
      setSettings(prev => ({ ...prev, contextFiles: [...prev.contextFiles, newFile] }));
    };
    reader.readAsText(file);
  };

  const removeFile = (id: string) => {
    setSettings(prev => ({ ...prev, contextFiles: prev.contextFiles.filter(f => f.id !== id) }));
  };

  const toggleAutoSend = () => {
    setSettings(prev => ({ ...prev, autoSend: !prev.autoSend }));
  };

  const saveApiKey = (key: string) => {
    localStorage.setItem("GEMINI_API_KEY", key);
    setSettings(prev => ({ ...prev, apiKey: key }));
  };

  return (
    // dvh ensures full height on mobile browsers including address bar accounting
    <div className="h-[100dvh] flex flex-col bg-background text-gray-100 font-sans overflow-hidden">
      
      {/* --- RESPONSIVE HEADER --- */}
      <header className="h-14 md:h-16 border-b border-gray-800 bg-surface/80 backdrop-blur-md flex items-center justify-between px-4 shrink-0 z-20 sticky top-0">
        <div className="flex items-center gap-2 md:gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
            <Cpu size={18} className="text-white" />
          </div>
          <h1 className="font-bold text-base md:text-lg tracking-tight hidden xs:block">Interview<span className="text-blue-400">Copilot</span></h1>
        </div>

        {/* Desktop Nav */}
        <div className="hidden md:flex items-center gap-3">
           <div className={`px-3 py-1 rounded-full text-xs font-medium flex items-center gap-2 border transition-all duration-300 ${isListening ? 'bg-red-500/10 border-red-500/50 text-red-400' : 'bg-gray-800 border-gray-700 text-gray-500'}`}>
              <div className={`w-2 h-2 rounded-full ${isListening ? 'bg-red-500 animate-pulse' : 'bg-gray-500'}`}></div>
              {isListening ? 'LIVE' : 'OFF'}
           </div>
           <button onClick={() => setShowContext(true)} className="p-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-all" title="Files"><FileText size={20} /></button>
           <button onClick={() => setShowSettings(true)} className={`p-2 rounded-lg transition-all ${!settings.apiKey ? 'text-red-400 animate-pulse' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`} title="Settings"><Settings size={20} /></button>
        </div>

        {/* Mobile Nav Toggle */}
        <div className="flex md:hidden items-center gap-2">
           <div className={`w-2 h-2 rounded-full ${isListening ? 'bg-red-500 animate-pulse' : 'bg-gray-700'}`}></div>
           <button onClick={() => setShowMobileMenu(!showMobileMenu)} className="p-2 text-gray-300"><Menu size={24} /></button>
        </div>
      </header>

      {/* Mobile Menu Dropdown */}
      {showMobileMenu && (
          <div className="absolute top-14 left-0 right-0 bg-surface border-b border-gray-800 p-4 z-30 flex flex-col gap-4 shadow-2xl md:hidden animate-in slide-in-from-top-2">
              <button onClick={() => { setShowContext(true); setShowMobileMenu(false); }} className="flex items-center gap-3 text-gray-300 p-2 rounded hover:bg-white/5">
                  <FileText size={20} /> Knowledge Base ({settings.contextFiles.length})
              </button>
              <button onClick={() => { setShowSettings(true); setShowMobileMenu(false); }} className="flex items-center gap-3 text-gray-300 p-2 rounded hover:bg-white/5">
                  <Settings size={20} /> Settings
              </button>
              <button onClick={() => { setShowHelp(true); setShowMobileMenu(false); }} className="flex items-center gap-3 text-gray-300 p-2 rounded hover:bg-white/5">
                  <HelpCircle size={20} /> Help Guide
              </button>
          </div>
      )}

      {/* --- CHAT AREA --- */}
      <main className="flex-1 flex overflow-hidden relative w-full">
        <div className="flex-1 flex flex-col max-w-4xl mx-auto w-full relative">
          
          <div ref={chatContainerRef} className="flex-1 overflow-y-auto p-4 md:p-6 space-y-4 md:space-y-6 pb-40 md:pb-48 scroll-smooth">
            {messages.length === 0 && (
                <div className="flex flex-col items-center justify-center h-[60%] text-gray-500 space-y-6 opacity-60 mt-10">
                    <div className="w-24 h-24 rounded-full bg-gray-800/50 flex items-center justify-center relative ring-1 ring-white/10">
                        <Mic size={40} className="text-gray-600" />
                        {settings.autoSend && <div className="absolute top-1 right-1 w-4 h-4 bg-green-500 rounded-full border-2 border-gray-900 shadow-[0_0_10px_rgba(34,197,94,0.5)]"></div>}
                    </div>
                    <div className="text-center px-6">
                        <p className="font-medium text-gray-300 mb-2 text-lg">Copilot Ready</p>
                        <p className="text-sm leading-relaxed max-w-xs mx-auto">
                            Listening for questions...<br/>
                            Ensure meeting audio is routed correctly.
                        </p>
                    </div>
                </div>
            )}
            
            {messages.map((msg) => (
              <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} animate-in slide-in-from-bottom-2 duration-300`}>
                <div className={`max-w-[90%] md:max-w-[80%] rounded-2xl p-3 md:p-5 shadow-lg ${
                  msg.role === 'user' 
                    ? 'bg-gray-800 text-gray-200 border border-gray-700 rounded-tr-sm' 
                    : msg.role === 'system'
                    ? 'bg-red-900/30 border border-red-800 text-red-200'
                    : 'bg-blue-600/10 border border-blue-500/20 text-blue-50 rounded-tl-sm backdrop-blur-sm'
                }`}>
                  <div className="text-[10px] font-bold mb-1 opacity-50 uppercase tracking-wider flex items-center gap-1">
                    {msg.role === 'user' ? <MessageSquare size={10} /> : <Zap size={10} />}
                    {msg.role === 'user' ? 'Transcript' : msg.role === 'system' ? 'System' : 'Answer'}
                  </div>
                  <div className="whitespace-pre-wrap leading-relaxed text-sm md:text-base">
                    {msg.content}
                  </div>
                </div>
              </div>
            ))}

             {isProcessing && (
              <div className="flex justify-start">
                 <div className="bg-surface border border-gray-700 rounded-2xl px-4 py-3 rounded-tl-sm flex items-center gap-2 text-gray-400 text-xs shadow-lg">
                    <span className="font-semibold text-blue-400 tracking-wider">THINKING</span>
                    <div className="flex gap-1">
                        <div className="w-1 h-1 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '0ms'}}></div>
                        <div className="w-1 h-1 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '150ms'}}></div>
                        <div className="w-1 h-1 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '300ms'}}></div>
                    </div>
                 </div>
              </div>
             )}
          </div>

          {/* --- INPUT BAR --- */}
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-background via-background to-transparent pt-4 pb-4 px-2 md:px-6 z-20">
            <div className="max-w-3xl mx-auto flex flex-col gap-2">
                
                {/* Speech Error */}
                {speechError && (
                    <div className="mx-auto bg-red-900/90 text-white px-3 py-1 rounded-full text-xs border border-red-500 flex items-center gap-2 shadow-lg backdrop-blur">
                        <AlertTriangle size={10} /> {speechError}
                    </div>
                )}

                {/* Main Control Panel */}
                <div className={`bg-surface/90 backdrop-blur-xl border rounded-2xl shadow-2xl transition-all duration-300 flex flex-col ${isListening ? 'border-blue-500/30 shadow-[0_0_20px_rgba(59,130,246,0.15)]' : 'border-gray-800'}`}>
                    
                    {/* Toolbar (Top of input) */}
                    <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/5">
                        <div className="flex items-center gap-2">
                            <button
                                onClick={toggleAutoSend}
                                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] md:text-xs font-bold transition-all border ${
                                    settings.autoSend 
                                    ? 'bg-blue-500/20 text-blue-300 border-blue-500/50' 
                                    : 'bg-white/5 text-gray-500 border-transparent'
                                }`}
                            >
                                <Zap size={12} className={settings.autoSend ? "fill-blue-400" : ""} />
                                {settings.autoSend ? 'AUTO' : 'MANUAL'}
                            </button>

                            <button
                                onClick={isListening ? stopListening : startListening}
                                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] md:text-xs font-bold transition-all border ${
                                    isListening 
                                    ? 'bg-red-500/20 text-red-400 border-red-500/50' 
                                    : 'bg-white/5 text-gray-500 border-transparent'
                                }`}
                            >
                                {isListening ? <Mic size={12} /> : <MicOff size={12} />}
                                {isListening ? 'ON' : 'OFF'}
                            </button>
                        </div>
                        
                        {!isProcessing && messages.length > 0 && (
                            <button onClick={handleRegenerate} className="text-gray-500 hover:text-white transition-colors p-1" title="Regenerate last answer">
                                <RefreshCw size={14} />
                            </button>
                        )}
                    </div>

                    {/* Text Input Area */}
                    <div className="relative p-2 flex items-end gap-2">
                        <div className="relative flex-1">
                             {/* Ghost Text */}
                             {interimText && (
                                <div className="absolute top-2.5 left-3 text-gray-500 pointer-events-none text-sm md:text-base whitespace-pre-wrap truncate w-full opacity-60 italic z-0">
                                    {inputText}{interimText}
                                </div>
                            )}
                            <textarea
                                ref={textareaRef}
                                value={inputText}
                                onChange={(e) => setInputText(e.target.value)}
                                placeholder={settings.autoSend ? "Listening for interviewer..." : "Type or speak context..."}
                                className="w-full bg-black/20 text-gray-100 placeholder-gray-600 px-3 py-2.5 focus:outline-none rounded-xl text-sm md:text-base leading-relaxed resize-none z-10 relative"
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
                                <button onClick={handleClear} className="p-2 text-gray-500 hover:text-white rounded-lg hover:bg-white/10 transition-colors">
                                    <X size={18} />
                                </button>
                            )}
                            <button 
                                onClick={handleManualSend}
                                disabled={!inputText.trim() || isProcessing}
                                className={`p-2 rounded-xl transition-all shadow-lg ${
                                    inputText.trim() && !isProcessing
                                    ? 'bg-blue-600 text-white hover:bg-blue-500' 
                                    : 'bg-gray-800 text-gray-600 cursor-not-allowed'
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

      {/* --- MODALS --- */}
      <Modal isOpen={showSettings} onClose={() => setShowSettings(false)} title="Settings">
         <div className="space-y-4">
            <div className="space-y-2">
                <label className="text-sm font-medium text-gray-300">Gemini API Key</label>
                <input 
                    type="password"
                    value={settings.apiKey}
                    onChange={(e) => saveApiKey(e.target.value)}
                    placeholder="Enter API Key"
                    className="w-full bg-black/30 border border-gray-700 rounded-lg px-4 py-3 text-white focus:ring-1 focus:ring-blue-500 outline-none text-sm"
                />
            </div>
         </div>
      </Modal>

      <Modal isOpen={showHelp} onClose={() => setShowHelp(false)} title="Audio Setup">
         <div className="space-y-4 text-gray-300 text-sm">
            <div className="p-3 bg-blue-900/20 border border-blue-500/30 rounded-lg">
                <p className="font-semibold text-blue-200">Goal: Isolate Interviewer Audio</p>
                <p className="opacity-80">Prevents the AI from transcribing your own answers.</p>
            </div>
            <ol className="list-decimal pl-5 space-y-2 text-gray-400">
                <li>Use a Virtual Audio Cable (VB-Cable).</li>
                <li>Set Meeting <strong>Speaker</strong> → Cable Input.</li>
                <li>Set Browser/App <strong>Mic</strong> → Cable Output.</li>
            </ol>
         </div>
      </Modal>

      <Modal isOpen={showContext} onClose={() => setShowContext(false)} title="Knowledge Base">
         <div className="space-y-4">
            <div className="flex justify-between items-center bg-gray-800/50 p-3 rounded-lg border border-gray-700">
                <div>
                    <p className="text-sm font-medium text-white">Upload Documents</p>
                    <p className="text-xs text-gray-500">Supported: .txt files</p>
                </div>
                <label className="cursor-pointer bg-blue-600 hover:bg-blue-500 text-white px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2">
                    <Upload size={14} /> Upload
                    <input type="file" accept=".txt" className="hidden" onChange={handleFileUpload} />
                </label>
            </div>

            <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
                {settings.contextFiles.map((file) => (
                    <div key={file.id} className="bg-surface border border-gray-700 rounded-lg p-3 flex items-center justify-between group">
                        <div className="flex items-center gap-3 overflow-hidden">
                            <div className={`p-2 rounded-lg shrink-0 ${file.type === 'resume' ? 'bg-purple-900/30 text-purple-400' : file.type === 'jd' ? 'bg-yellow-900/30 text-yellow-400' : 'bg-gray-700/50 text-gray-300'}`}>
                                {file.type === 'resume' ? <FileCheck size={18} /> : <FileText size={18} />}
                            </div>
                            <div className="min-w-0">
                                <h4 className="font-medium text-sm text-gray-200 truncate">{file.name}</h4>
                                <p className="text-[10px] text-gray-500 uppercase tracking-wider">{file.type}</p>
                            </div>
                        </div>
                        <button onClick={() => removeFile(file.id)} className="text-gray-500 hover:text-red-400 p-2 rounded hover:bg-white/5 transition-colors">
                            <Trash2 size={16} />
                        </button>
                    </div>
                ))}
                {settings.contextFiles.length === 0 && (
                    <div className="text-center py-8 text-gray-500 text-sm border-2 border-dashed border-gray-800 rounded-xl">
                        No files uploaded.
                    </div>
                )}
            </div>
         </div>
      </Modal>

    </div>
  );
}
