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

export const Shot33: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();

	// Timeline scaling: 8.86s total
	// Segments: 0-6s (Suspicious), 6-12s (Division) -> ~50/50 split
	const splitFrame = Math.round(durationInFrames / 2);

	// Ruler Division Animation
	const divisionProgress = interpolate(
		frame,
		[splitFrame, splitFrame + 20],
		[0, 100],
		{extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.quad)}
	);

	// Cold Geometric Lines
	const linesOpacity = interpolate(frame, [splitFrame + 10, splitFrame + 30], [0, 0.4]);

	return (
		<AbsoluteFill style={{backgroundColor: '#1a1a1a'}}>
			{/* Main Image */}
			<AbsoluteFill>
				<Img
					src={staticFile('back_to_back_division.png')}
					style={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
						filter: 'grayscale(0.2) contrast(1.1)',
					}}
				/>
			</AbsoluteFill>

			{/* Strict Division Ruler */}
			<AbsoluteFill className="justify-center items-center">
				<div 
					className="bg-white/80 w-2 h-full shadow-2xl"
					style={{
						clipPath: `inset(0 0 ${100 - divisionProgress}% 0)`,
						boxShadow: '0 0 20px rgba(255,255,255,0.5)',
					}}
				/>
				{/* Measuring Ticks on Ruler */}
				<div 
					className="absolute w-10 h-full flex flex-col justify-between py-10 opacity-60"
					style={{
						clipPath: `inset(0 0 ${100 - divisionProgress}% 0)`,
					}}
				>
					{new Array(20).fill(0).map((_, i) => (
						<div key={i} className="w-4 h-0.5 bg-white" />
					))}
				</div>
			</AbsoluteFill>

			{/* Cold Geometric Grid Overlay */}
			<AbsoluteFill
				style={{
					opacity: linesOpacity,
					background: 'repeating-linear-gradient(0deg, transparent, transparent 49px, rgba(255,255,255,0.1) 50px), repeating-linear-gradient(90deg, transparent, transparent 49px, rgba(255,255,255,0.1) 50px)',
					pointerEvents: 'none',
				}}
			/>

			{/* Text Overlay */}
			<AbsoluteFill className="justify-center items-center">
				<div 
					className="bg-black/80 px-8 py-4 rounded shadow-2xl border-l-4 border-r-4 border-white transform skew-x-12"
					style={{
						opacity: interpolate(frame, [splitFrame + 15, splitFrame + 35], [0, 1]),
						transform: `scale(${interpolate(frame, [splitFrame + 15, splitFrame + 35], [0.8, 1], {extrapolateRight: 'clamp'})})`
					}}
				>
					<h2 
						className="text-white text-4xl font-bold uppercase tracking-tight text-center"
						style={{fontFamily: 'Inter, sans-serif'}}
					>
						ГК РФ → Долевая собственность
					</h2>
				</div>
			</AbsoluteFill>

			<Audio src={staticFile('shot33_voice.mp3')} />
		</AbsoluteFill>
	);
};
