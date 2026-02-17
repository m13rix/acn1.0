import {
	AbsoluteFill,
	interpolate,
	useCurrentFrame,
	useVideoConfig,
	Img,
	staticFile,
	Audio,
	random,
} from 'remotion';
import React from 'react';

export const Shot9: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();

	// Timeline scaling: 4.61s total
	// Original: 0-7s (Tearing), 7-10s (Stop)
	// New: approx 3.23s (Tearing), 1.38s (Stop)
	const stopFrame = Math.round((7 / 10) * durationInFrames);

	// 1. Rapid Page Tearing Animation (0 - stopFrame)
	// We simulate this by rapidly changing the scale and rotation of the calendar
	// and potentially adding a flicker/blur
	const isTearing = frame < stopFrame;
	
	const tearingRotation = isTearing ? (random(frame) - 0.5) * 10 : 0;
	const tearingScale = isTearing ? 1 + random(frame + 100) * 0.1 : 1;
	const tearingBlur = isTearing ? random(frame + 200) * 5 : 0;

	// 2. Abrupt Stop and Camera Shake (jitters)
	const jitterFrame = frame - stopFrame;
	const jitterX = jitterFrame >= 0 && jitterFrame < 15 
		? (random(frame + 300) - 0.5) * 20 * Math.exp(-jitterFrame / 5) 
		: 0;
	const jitterY = jitterFrame >= 0 && jitterFrame < 15 
		? (random(frame + 400) - 0.5) * 20 * Math.exp(-jitterFrame / 5) 
		: 0;

	// 3. Text Overlay with Flash Transition
	// 'тридцать дней' -> 'сегодня'
	const textSwitchFrame = stopFrame + 10;
	const isAfterSwitch = frame >= textSwitchFrame;
	
	// Flash effect
	const flashOpacity = interpolate(
		frame,
		[textSwitchFrame - 2, textSwitchFrame, textSwitchFrame + 5],
		[0, 0.8, 0],
		{extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
	);

	return (
		<AbsoluteFill style={{backgroundColor: 'black'}}>
			<AbsoluteFill
				style={{
					transform: `scale(${tearingScale}) rotate(${tearingRotation}deg) translate(${jitterX}px, ${jitterY}px)`,
					filter: `blur(${tearingBlur}px)`,
				}}
			>
				<Img
					src={staticFile('calendar_month.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
					}}
				/>
			</AbsoluteFill>

			{/* Flash Transition Overlay */}
			<AbsoluteFill
				style={{
					backgroundColor: 'white',
					opacity: flashOpacity,
					pointerEvents: 'none',
				}}
			/>

			{/* Text Overlay */}
			{frame >= stopFrame && (
				<AbsoluteFill
					className="justify-center items-center"
				>
					<div
						className="bg-black/40 px-10 py-5 rounded-2xl backdrop-blur-md border border-white/20"
						style={{
							opacity: interpolate(frame, [stopFrame, stopFrame + 5], [0, 1])
						}}
					>
						<h1
							className="text-white text-8xl font-black uppercase tracking-tighter"
							style={{
								fontFamily: 'Inter, sans-serif',
								textShadow: '0 0 20px rgba(255,255,255,0.3)',
							}}
						>
							{!isAfterSwitch ? 'тридцать дней' : 'сегодня'}
						</h1>
					</div>
				</AbsoluteFill>
			)}

			<Audio src={staticFile('shot9_voice.mp3')} />
		</AbsoluteFill>
	);
};
