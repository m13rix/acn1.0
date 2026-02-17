import {
	AbsoluteFill,
	interpolate,
	useCurrentFrame,
	useVideoConfig,
	Img,
	staticFile,
	Audio,
	Easing,
} from 'remotion';
import React from 'react';

export const Shot25: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();

	// Timeline scaling: 6.53s total
	// Segments: 0-6s (Folder), 6-12s (Virus) -> ~50/50 split
	const splitFrame = Math.round(durationInFrames / 2);

	// 1. Folder Animation (0 - splitFrame)
	// Shake before "break"
	const shakeStart = splitFrame - 20;
	const shake = frame > shakeStart && frame < splitFrame
		? Math.sin(frame * 1.5) * 10
		: 0;

	// Text 1 Opacity
	const text1Opacity = interpolate(frame, [0, 10, shakeStart], [0, 1, 0], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
	});

	// 2. Lock Break / Virus Emerge (splitFrame - end)
	const virusProgress = interpolate(
		frame,
		[splitFrame, durationInFrames],
		[0, 1],
		{easing: Easing.out(Easing.back(1.5))}
	);

	const virusScale = interpolate(virusProgress, [0, 1], [0.5, 1.2]);
	const virusOpacity = interpolate(virusProgress, [0, 0.2], [0, 1], {extrapolateRight: 'clamp'});

	// Text 2 Opacity
	const text2Opacity = interpolate(frame, [splitFrame + 10, splitFrame + 30], [0, 1], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
	});

	// Red Alert Pulse
	const pulse = Math.sin(frame * 0.3) * 0.2 + 0.8;

	return (
		<AbsoluteFill style={{backgroundColor: '#f0f0f0'}}>
			{/* Segment 1: Medical Folder */}
			<AbsoluteFill
				style={{
					transform: `translateX(${shake}px)`,
				}}
			>
				<Img
					src={staticFile('medical_folder.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
					}}
				/>
				
				{/* "Medical Secret" Label on Folder */}
				<AbsoluteFill className="justify-center items-center">
					<div 
						className="bg-white/80 px-6 py-2 border-2 border-red-800 transform -rotate-3"
						style={{opacity: text1Opacity}}
					>
						<h2 
							className="text-red-900 text-4xl font-bold uppercase tracking-widest"
							style={{fontFamily: 'Inter, sans-serif'}}
						>
							Медицинская тайна
						</h2>
						{/* Mock Lock Icon */}
						<div className="absolute -top-10 left-1/2 transform -translate-x-1/2 text-5xl">
							🔒
						</div>
					</div>
				</AbsoluteFill>
			</AbsoluteFill>

			{/* Segment 2: Virus Emerging */}
			<AbsoluteFill
				className="justify-center items-center"
				style={{
					opacity: virusOpacity,
					transform: `scale(${virusScale})`,
				}}
			>
				<Img
					src={staticFile('virus_sealed.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'contain',
						filter: 'drop-shadow(0 0 20px rgba(255, 0, 0, 0.5))',
					}}
				/>
				{/* Breaking Lock Particles (Simulated) */}
				{frame > splitFrame && frame < splitFrame + 20 && (
					<div className="absolute text-6xl">💥</div>
				)}
			</AbsoluteFill>

			{/* Red Flash Overlay at Break */}
			{frame > splitFrame && frame < splitFrame + 5 && (
				<AbsoluteFill style={{backgroundColor: 'white', opacity: 0.8}} />
			)}

			{/* Text 2 Overlay */}
			<AbsoluteFill 
				className="justify-end items-center pb-20"
				style={{opacity: text2Opacity}}
			>
				<div 
					className="bg-black/80 px-8 py-4 rounded-xl border-l-8 border-red-600"
					style={{transform: `scale(${pulse})`}}
				>
					<h2 
						className="text-white text-3xl font-bold uppercase mb-2"
						style={{fontFamily: 'Inter, sans-serif'}}
					>
						Статья 15 СК РФ
					</h2>
					<h3 
						className="text-red-400 text-2xl font-normal uppercase tracking-wide"
						style={{fontFamily: 'Inter, sans-serif'}}
					>
						Врачебная тайна
					</h3>
				</div>
			</AbsoluteFill>

			<Audio src={staticFile('shot25_voice.mp3')} />
		</AbsoluteFill>
	);
};
