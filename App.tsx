
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Settings, Mic, MicOff, Send, FileText, Upload, Trash2, Cpu, FileCheck, RefreshCw, HelpCircle, AlertTriangle, Zap, MessageSquare, Edit3, X } from 'lucide-react';
import { geminiService } from './services/geminiService';
import { useSpeechRecognition } from './hooks/useSpeechRecognition';
import { INITIAL_JD_TEXT, INITIAL_RESUME_TEXT } from './constants';
import { Message, AppSettings, ContextFile } from './types';

// --- Modal Component ---
const Modal = ({ isOpen, onClose, title, children }: any) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-surface border border-gray-700 rounded-xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col shadow-2xl animate-in fade-in zoom-in duration-200">
        <div className="p-4 border-b border-gray-700 flex justify-between items-center bg-gray-900/50">
          <h2 className="text-xl font-bold text-white flex items-center gap-2">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">✕</button>
        </div>
        <div className="p-6 overflow-y-auto custom-scrollbar">
          {children}
        </div>
      </div>
    </div>
  );
};

export default function App() {
  // --- State ---
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState(""); // The committed text in the input box
  const [interimText, setInterimText] = useState(""); // The fleeting text (ghost text)
  
  const [isProcessing, setIsProcessing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  
  const [settings, setSettings] = useState<AppSettings>({
    apiKey: localStorage.getItem("GEMINI_API_KEY") || "",
    autoSend: false, 
    contextFiles: [
      { id: '1', name: 'Resume - Venu Madhav', content: INITIAL_RESUME_TEXT, type: 'resume' },
      { id: '2', name: 'Job Description - Goldman Sachs', content: INITIAL_JD_TEXT, type: 'jd' }
    ]
  });

  const chatContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  
  // Refs for Auto-Send Logic
  const silenceTimerRef = useRef<any>(null);
  const inputTextRef = useRef(inputText);

  useEffect(() => {
    inputTextRef.current = inputText;
    // Auto-resize textarea
    if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
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

  // --- Core Send Logic ---
  const executeSend = async (textToSend: string) => {
      if (!textToSend.trim()) return;
      
      const userMsg: Message = {
        id: Date.now().toString(),
        role: 'user',
        content: textToSend,
        timestamp: Date.now()
      };
  
      setMessages(prev => [...prev, userMsg]);
      setIsProcessing(true);
      // Clear inputs immediately
      setInterimText("");
      setInputText(""); 
  
      try {
        const responseText = await geminiService.generateResponse(
          userMsg.content,
          messages, 
          settings.contextFiles
        );
        
        // Filter out "Listening..." status messages
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
          content: "Error generating response. Please check your API Key settings.",
          timestamp: Date.now()
        };
        setMessages(prev => [...prev, errorMsg]);
      } finally {
        setIsProcessing(false);
      }
  };

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

        if (settings.autoSend) {
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
  }, [settings.autoSend]);

  const { isListening, error: speechError, startListening, stopListening } = useSpeechRecognition({
    onResult: handleSpeechResult,
    onError: (err) => console.error("Speech Error:", err)
  });

  // --- Effects for Auto Mode ---
  useEffect(() => {
      if (settings.autoSend && !isListening) {
          startListening();
      }
  }, [settings.autoSend, isListening, startListening]);

  // --- UI Handlers ---
  const handleManualSend = () => {
    if (!inputText.trim() || isProcessing) return;
    if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
    }
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
    setMessages(prev => {
        const reversed = [...prev].reverse();
        const lastUserIdx = reversed.findIndex(m => m.role === 'user');
        if (lastUserIdx === -1) return prev;
        return reversed.slice(lastUserIdx).reverse();
    });

    try {
        const historyForService = messages.filter(m => m.id !== lastUserMsg.id && m.role !== 'system');
        const responseText = await geminiService.generateResponse(
            lastUserMsg.content,
            historyForService,
            settings.contextFiles
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
    } catch (err) {
        console.error(err);
    } finally {
        setIsProcessing(false);
    }
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
      setSettings(prev => ({
        ...prev,
        contextFiles: [...prev.contextFiles, newFile]
      }));
    };
    reader.readAsText(file);
  };

  const removeFile = (id: string) => {
    setSettings(prev => ({
      ...prev,
      contextFiles: prev.contextFiles.filter(f => f.id !== id)
    }));
  };

  const toggleAutoSend = () => {
    const nextState = !settings.autoSend;
    setSettings(prev => ({ ...prev, autoSend: nextState }));
    if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = null;
    }
  };

  const saveApiKey = (key: string) => {
    localStorage.setItem("GEMINI_API_KEY", key);
    setSettings(prev => ({ ...prev, apiKey: key }));
  };

  return (
    <div className="h-screen flex flex-col bg-background text-gray-100 font-sans overflow-hidden">
      
      {/* --- HEADER --- */}
      <header className="h-16 border-b border-gray-800 bg-surface/50 backdrop-blur-md flex items-center justify-between px-6 shrink-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
            <Cpu size={18} className="text-white" />
          </div>
          <h1 className="font-bold text-lg tracking-tight">Interview<span className="text-blue-400">Copilot</span></h1>
        </div>

        <div className="flex items-center gap-3">
           <div className={`px-3 py-1 rounded-full text-xs font-medium flex items-center gap-2 border transition-all duration-300 ${isListening ? 'bg-red-500/10 border-red-500/50 text-red-400 shadow-[0_0_10px_rgba(239,68,68,0.2)]' : 'bg-gray-800 border-gray-700 text-gray-500'}`}>
              <div className={`w-2 h-2 rounded-full ${isListening ? 'bg-red-500 animate-pulse' : 'bg-gray-500'}`}></div>
              {isListening ? 'LIVE: DEVICE AUDIO' : 'MIC OFF'}
           </div>

           <button onClick={() => setShowHelp(true)} className="p-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-all" title="Audio Isolation Guide">
             <HelpCircle size={20} />
           </button>

           <button onClick={() => setShowContext(true)} className="p-2 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-all" title="Context & Files">
             <FileText size={20} />
           </button>

           <button onClick={() => setShowSettings(true)} className={`p-2 rounded-lg transition-all ${!settings.apiKey ? 'text-red-400 bg-red-900/20 animate-pulse' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`} title="Settings">
             <Settings size={20} />
           </button>
        </div>
      </header>

      {/* --- MAIN CONTENT --- */}
      <main className="flex-1 flex overflow-hidden relative">
        <div className="flex-1 flex flex-col max-w-5xl mx-auto w-full relative">
          
          {/* Messages */}
          <div ref={chatContainerRef} className="flex-1 overflow-y-auto p-6 space-y-6 pb-48">
            {messages.length === 0 && (
                <div className="flex flex-col items-center justify-center h-full text-gray-500 space-y-4 opacity-60">
                    <div className="w-20 h-20 rounded-full bg-gray-800 flex items-center justify-center relative">
                        <Mic size={40} className="text-gray-600" />
                        {settings.autoSend && <div className="absolute top-0 right-0 w-4 h-4 bg-green-500 rounded-full border-2 border-gray-900"></div>}
                    </div>
                    <div className="text-center max-w-md">
                        <p className="font-medium text-gray-300 mb-2">Ready for Questions</p>
                        <p className="text-sm">
                            1. Incoming Voice (Interviewer) is transcribed below.<br/>
                            2. <strong>Auto-Mode</strong> is {settings.autoSend ? <span className="text-green-400 font-bold">ON</span> : "OFF"}.<br/>
                            3. Edit transcriptions before sending if needed.
                        </p>
                    </div>
                </div>
            )}
            
            {messages.map((msg) => (
              <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'} animate-in slide-in-from-bottom-2 duration-300`}>
                <div className={`max-w-[85%] rounded-2xl p-4 shadow-lg ${
                  msg.role === 'user' 
                    ? 'bg-gray-800 text-gray-200 border border-gray-700 rounded-tr-sm' 
                    : msg.role === 'system'
                    ? 'bg-red-900/30 border border-red-800 text-red-200'
                    : 'bg-gradient-to-br from-blue-900/40 to-blue-800/20 border border-blue-500/30 text-blue-50 rounded-tl-sm backdrop-blur-sm'
                }`}>
                  <div className="text-xs font-bold mb-1 opacity-50 uppercase tracking-wider flex items-center gap-1">
                    {msg.role === 'user' ? <MessageSquare size={10} /> : <Zap size={10} />}
                    {msg.role === 'user' ? 'Transcript' : msg.role === 'system' ? 'System' : 'Suggested Answer'}
                  </div>
                  <div className="whitespace-pre-wrap leading-relaxed">
                    {msg.content}
                  </div>
                </div>
              </div>
            ))}

            {/* Processing Indicator */}
             {isProcessing && (
              <div className="flex justify-start">
                 <div className="bg-surface border border-gray-700 rounded-2xl p-4 rounded-tl-sm flex items-center gap-2 text-gray-400 text-sm shadow-lg">
                    <span className="text-xs font-medium mr-2 text-blue-400">GENERATING</span>
                    <div className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '0ms'}}></div>
                    <div className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '150ms'}}></div>
                    <div className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '300ms'}}></div>
                 </div>
              </div>
             )}
          </div>

          {/* --- SEARCH PANEL (BOTTOM BAR) --- */}
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-background via-background to-transparent pt-12 pb-8 px-6 z-20">
            <div className="max-w-3xl mx-auto">
                {/* Error Banner */}
                {speechError && (
                    <div className="mb-2 flex justify-center">
                         <div className="bg-red-900/80 text-white px-4 py-1 rounded-full text-xs border border-red-500 flex items-center gap-2 shadow-lg backdrop-blur-md">
                             <AlertTriangle size={12} />
                             {speechError}
                         </div>
                    </div>
                )}

                <div className={`bg-surface border rounded-2xl shadow-2xl transition-all duration-300 flex flex-col ${isListening ? 'border-blue-500/30 ring-1 ring-blue-500/10' : 'border-gray-700'}`}>
                    
                    {/* Input Area (Search Bar) */}
                    <div className="relative p-2">
                         {interimText && (
                            <div className="absolute top-4 left-4 right-12 text-gray-500 pointer-events-none whitespace-pre-wrap truncate text-lg">
                                <span className="opacity-0">{inputText}</span>
                                <span className="opacity-60 italic">{interimText}</span>
                            </div>
                        )}
                        <textarea
                            ref={textareaRef}
                            value={inputText}
                            onChange={(e) => setInputText(e.target.value)}
                            placeholder={settings.autoSend ? "Listening..." : "Waiting for question..."}
                            rows={1}
                            className="w-full bg-transparent text-gray-100 placeholder-gray-600 px-3 py-2 pr-12 focus:outline-none resize-none max-h-[200px] font-medium text-lg leading-relaxed rounded-xl"
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    handleManualSend();
                                }
                            }}
                        />
                        
                        <div className="absolute bottom-2 right-2 flex items-center gap-1">
                            {inputText && (
                                <button onClick={handleClear} className="p-1.5 text-gray-500 hover:text-white rounded-full transition-colors">
                                    <X size={16} />
                                </button>
                            )}
                            <button 
                                onClick={handleManualSend}
                                disabled={!inputText.trim() || isProcessing}
                                className={`p-2 rounded-xl transition-all ${
                                    inputText.trim() && !isProcessing
                                    ? 'bg-blue-600 text-white shadow-lg hover:bg-blue-500 scale-100' 
                                    : 'bg-gray-800 text-gray-600 scale-90 opacity-50 cursor-not-allowed'
                                }`}
                            >
                                <Send size={18} />
                            </button>
                        </div>
                    </div>

                    {/* Toolbar */}
                    <div className="flex items-center justify-between px-3 py-2 border-t border-white/5 bg-black/20 rounded-b-2xl">
                         <div className="flex items-center gap-2">
                            <button
                                onClick={toggleAutoSend}
                                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all border ${
                                    settings.autoSend 
                                    ? 'bg-blue-500/20 text-blue-300 border-blue-500/50' 
                                    : 'bg-transparent text-gray-500 border-transparent hover:bg-gray-800'
                                }`}
                            >
                                <Zap size={14} className={settings.autoSend ? "fill-blue-400" : ""} />
                                {settings.autoSend ? 'Auto-Send ON' : 'Auto-Send OFF'}
                            </button>

                            {!settings.autoSend && (
                                <button
                                    onClick={isListening ? stopListening : startListening}
                                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all border ${
                                        isListening 
                                        ? 'bg-red-500/20 text-red-400 border-red-500/50' 
                                        : 'bg-transparent text-gray-500 border-transparent hover:bg-gray-800'
                                    }`}
                                >
                                    {isListening ? <Mic size={14} /> : <MicOff size={14} />}
                                    {isListening ? 'Mic ON' : 'Mic OFF'}
                                </button>
                            )}
                         </div>
                         
                         <div className="flex items-center gap-2">
                             {messages.length > 0 && !isProcessing && (
                                 <button
                                    onClick={handleRegenerate}
                                    className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white transition-colors px-2 py-1 rounded hover:bg-white/5"
                                 >
                                    <RefreshCw size={12} />
                                    Regenerate
                                 </button>
                             )}
                         </div>
                    </div>
                </div>
            </div>
          </div>
        </div>
      </main>

      {/* --- SETTINGS MODAL --- */}
      <Modal isOpen={showSettings} onClose={() => setShowSettings(false)} title="Application Settings">
         <div className="space-y-6">
            <div className="space-y-2">
                <label className="text-sm font-medium text-gray-300">Gemini API Key</label>
                <input 
                    type="password"
                    value={settings.apiKey}
                    onChange={(e) => saveApiKey(e.target.value)}
                    placeholder="Enter your API Key..."
                    className="w-full bg-black/30 border border-gray-700 rounded-lg px-4 py-2 text-white focus:ring-1 focus:ring-blue-500 outline-none placeholder-gray-600"
                />
                <p className="text-xs text-gray-500">
                    Your key is stored locally in your browser.
                </p>
            </div>
         </div>
      </Modal>

      {/* --- HELP MODAL --- */}
      <Modal isOpen={showHelp} onClose={() => setShowHelp(false)} title="Audio Setup Guide">
         <div className="space-y-4 text-gray-300">
            <div className="p-4 bg-gray-800/50 rounded-lg border border-gray-700">
                <h4 className="font-bold text-white mb-2">Goal: Record Interviewer ONLY</h4>
                <p className="text-sm">To prevent the AI from hearing YOU (Venu), you should route the meeting audio directly to this app.</p>
            </div>
            
            <div className="space-y-2 text-sm">
                <p className="font-bold text-blue-400">Recommended Setup (VB-Cable):</p>
                <ol className="list-decimal pl-5 space-y-1 text-gray-400">
                    <li>Install a Virtual Audio Cable.</li>
                    <li>Set Meeting App (Zoom/Teams) <strong>Speaker</strong> to "Cable Input".</li>
                    <li>Set Computer <strong>Microphone</strong> to "Cable Output".</li>
                    <li>This ensures Copilot hears the interviewer but hears silence when you speak.</li>
                </ol>
            </div>
         </div>
      </Modal>

      {/* --- CONTEXT MODAL --- */}
      <Modal isOpen={showContext} onClose={() => setShowContext(false)} title="Knowledge Base">
         <div className="space-y-6">
            <div className="flex justify-between items-center">
                <p className="text-sm text-gray-400">Context for the AI Model</p>
                <label className="flex items-center gap-2 cursor-pointer bg-blue-600 hover:bg-blue-500 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors">
                    <Upload size={14} />
                    <span>Upload .txt</span>
                    <input type="file" accept=".txt" className="hidden" onChange={handleFileUpload} />
                </label>
            </div>

            <div className="grid gap-3">
                {settings.contextFiles.map((file) => (
                    <div key={file.id} className="bg-gray-800/50 border border-gray-700 rounded-lg p-3 flex items-start justify-between group hover:border-gray-600 transition-colors">
                        <div className="flex items-start gap-3 overflow-hidden">
                            <div className={`mt-1 p-1.5 rounded-md ${file.type === 'resume' ? 'bg-purple-500/20 text-purple-400' : file.type === 'jd' ? 'bg-yellow-500/20 text-yellow-400' : 'bg-gray-700 text-gray-300'}`}>
                                {file.type === 'resume' ? <FileCheck size={16} /> : <FileText size={16} />}
                            </div>
                            <div>
                                <h4 className="font-medium text-sm text-gray-200 truncate pr-4">{file.name}</h4>
                                <p className="text-xs text-gray-500 mt-0.5 uppercase tracking-wider">{file.type}</p>
                            </div>
                        </div>
                        {file.type === 'custom' && (
                             <button onClick={() => removeFile(file.id)} className="text-gray-500 hover:text-red-400 p-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                <Trash2 size={16} />
                             </button>
                        )}
                    </div>
                ))}
            </div>
         </div>
      </Modal>

    </div>
  );
}
